'use strict'

const awsSdk = require('aws-sdk')
const cryptoUtil = require('./cryptoUtil')
const s3Helper = require('../lib/s3Helper')

const CONFIG = require('./config')
const S3_MAX_RETRIES = 1
const EXPIRED_CREDENTIAL_ERRORS = [
  /The provided token has expired\./,
  /Invalid according to Policy: Policy expired\./
]

const checkFetchStatus = (response) => {
  if (response.status >= 200 && response.status < 300) {
    return response
  } else {
    var error = new Error(response.statusText)
    error.response = response
    throw error
  }
}

const isExpiredCredentialError = (error) => {
  return EXPIRED_CREDENTIAL_ERRORS.some((message) => {
    return error.message.match(message)
  })
}

const getTime = () => {
  return Math.floor(Date.now() / 1000)
}

/**
 * @param {{
 *   apiVersion: <string>,
 *   credentialsBytes: <Uint8Array=>, // If missing, will be requested
 *   keys: {{ // User's encryption keys
 *     publicKey: <Uint8Array>, secretKey: <Uint8Array>,
 *     fingerprint: <string=>, secretboxKey: <Uint8Array>}},
 *   serializer: <Object>,
 *   serverUrl: <string>
 * }} opts
 */
const RequestUtil = function (opts = {}) {
  if (!opts.apiVersion) { throw new Error('Missing apiVersion.') }
  if (!opts.keys) { throw new Error('Missing keys.') }
  if (!opts.serializer) { throw new Error('Missing serializer.') }
  if (!opts.serverUrl) { throw new Error('Missing serverUrl.') }
  this.apiVersion = opts.apiVersion
  this.serializer = opts.serializer
  this.serverUrl = opts.serverUrl
  this.userId = Buffer.from(opts.keys.publicKey).toString('base64')
  this.encrypt = cryptoUtil.Encrypt(this.serializer, opts.keys.secretboxKey, CONFIG.nonceCounter)
  this.decrypt = cryptoUtil.Decrypt(this.serializer, opts.keys.secretboxKey)
  this.sign = cryptoUtil.Sign(opts.keys.secretKey)
  if (opts.credentialsBytes) {
    const credentials = this.parseAWSResponse(opts.credentialsBytes)
    this.saveAWSCredentials(credentials)
  }
}

/**
 * Save parsed AWS credential response to be used with AWS requests.
 * @param {{s3: Object, postData: Object, expiration: string, bucket: string, region: string}}
 * @return {Promise} After it resolves, the object is ready to make requests.
 */
RequestUtil.prototype.refreshAWSCredentials = function () {
  const timestampString = getTime().toString()
  const userId = window.encodeURIComponent(this.userId)
  const url = `${this.serverUrl}/${userId}/credentials`
  const bytes = this.serializer.stringToByteArray(timestampString)
  const params = {
    method: 'POST',
    body: this.sign(bytes)
  }
  return window.fetch(url, params)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Credential server response ${response.status}`)
      }
      return response.arrayBuffer()
    })
    .then((buffer) => {
      console.log('Refreshed credentials.')
      const credentials = this.parseAWSResponse(new Uint8Array(buffer))
      this.saveAWSCredentials(credentials)
      return Promise.resolve(this)
    })
}

/**
 * Save parsed AWS credential response to be used with AWS requests.
 * @param {{s3: Object, postData: Object, expiration: string, bucket: string, region: string}}
 */
RequestUtil.prototype.saveAWSCredentials = function (parsedResponse) {
  this.s3 = parsedResponse.s3
  this.postData = parsedResponse.postData
  this.expiration = parsedResponse.expiration
  this.bucket = parsedResponse.bucket
  this.region = parsedResponse.region
  this.s3PostEndpoint = `https://${this.bucket}.s3.dualstack.${this.region}.amazonaws.com`
}

/**
 * Parses an AWS credentials endpoint response.
 * @param {Uint8Array} bytes response body
 * @return {{s3: Object, postData: Object, expiration: string, bucket: string, region: string}}
 */
RequestUtil.prototype.parseAWSResponse = function (bytes) {
  const serializer = this.serializer
  if (!serializer) {
    throw new Error('Missing proto serializer object.')
  }
  const parsedBody = serializer.byteArrayToCredentials(bytes)
  const credentials = parsedBody.aws
  if (!credentials) {
    throw new Error('AWS did not return credentials!')
  }
  const postData = parsedBody.s3Post
  if (!postData) {
    throw new Error('AWS did not return s3Post data!')
  }
  const region = parsedBody.region
  if (!region) {
    throw new Error('AWS did not return region!')
  }
  const bucket = parsedBody.bucket
  if (!bucket) {
    throw new Error('AWS did not return bucket!')
  }
  const expiration = credentials.expiration
  const s3 = new awsSdk.S3({
    convertResponseTypes: false,
    credentials: new awsSdk.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }),
    // The bucket name is prepended to the endpoint to build the actual request URL, e.g.
    // https://brave-sync-staging.s3.dualstack.us-west-2.amazonaws.com
    endpoint: `https://s3.dualstack.${region}.amazonaws.com`,
    maxRetries: S3_MAX_RETRIES,
    region: region,
    sslEnabled: true,
    useDualstack: true
  })
  return {s3, postData, expiration, bucket, region}
}

/**
 * @param {string} category - the category ID
 * @param {number=} startAt return records with timestamp >= startAt (e.g. 1482435340)
 * @returns {Promise(Array.<Uint8Array>)}
 */
RequestUtil.prototype.list = function (category, startAt) {
  const prefix = `${this.apiVersion}/${this.userId}/${category}`
  let options = {
    MaxKeys: 1000,
    Bucket: this.bucket,
    Prefix: prefix
  }
  if (startAt) { options.StartAfter = `${prefix}/${startAt}` }
  return this.withRetry(() => {
    return s3Helper.listObjects(this.s3, options)
  }).then((data) => {
    return data.map((s3Object) => {
      const parsedKey = s3Helper.parseS3Key(s3Object.Key)
      // TODO: Recombine split records
      const decodedData = s3Helper.s3StringToByteArray(parsedKey.recordPartString)
      return decodedData
    })
  })
}

/**
 * Record S3 prefix with current timestamp.
 * {apiVersion}/{userId}/{category}/{timestamp}/
 * @returns {string}
 */
RequestUtil.prototype.currentRecordPrefix = function (category) {
  return `${this.apiVersion}/${this.userId}/${category}/${getTime()}/`
}

/**
 * Puts a single record, splitting it into multiple objects if needed.
 * @param {string} category - the category ID
 * @param {Uint8Array} record - the object content, serialized and encrypted
 */
RequestUtil.prototype.put = function (category, record) {
  const s3Prefix = this.currentRecordPrefix(category)
  const s3Keys = s3Helper.encodeDataToS3KeyArray(s3Prefix, record)
  return this.withRetry(() => {
    const fetchPromises = s3Keys.map((key, _i) => {
      const params = {
        method: 'POST',
        body: this.s3PostFormData(key)
      }
      return window.fetch(this.s3PostEndpoint, params)
        .then(checkFetchStatus)
    })
    return Promise.all(fetchPromises)
  })
}

RequestUtil.prototype.s3PostFormData = function (objectKey) {
  let formData = new FormData() // eslint-disable-line
  formData.append('key', objectKey)
  for (let key of Object.keys(this.postData)) {
    formData.append(key, this.postData[key])
  }
  formData.append('file', new Uint8Array([]))
  return formData
}

/**
 * In S3 you can't delete all keys matching a prefix, so you need to list by
 * prefix then delete them all.
 * @param {string} prefix
 */
RequestUtil.prototype.s3DeletePrefix = function (prefix) {
  return this.withRetry(() => {
    return s3Helper.deletePrefix(this.s3, this.bucket, prefix)
  })
}

RequestUtil.prototype.deleteUser = function () {
  return this.s3DeletePrefix(`${this.apiVersion}/${this.userId}`)
}

/**
 * @param {string} category - the category ID
 */
RequestUtil.prototype.deleteCategory = function (category) {
  return this.s3DeletePrefix(`${this.apiVersion}/${this.userId}/${category}`)
}

/**
 * Wrapper to call a function and refresh credentials if needed.
 * @param {Function(Promise)} Function which returns a Promise.
 * @param {number} retries Retries left. You probably don't need to change this.
 * @param {Error=} previousError Buffer with the previous error, for internal use.
 */
RequestUtil.prototype.withRetry = function (myFun, retries = 1, previousError) {
  if (retries < 0) { throw previousError }

  return new Promise((resolve, reject) => {
    const callMyFun = () => {
      myFun()
        .then((...args) => { resolve(...args) })
        .catch((error) => {
          const retry = () => {
            try {
              this.withRetry(myFun, retries - 1, error)
                .then((...args) => { resolve(...args) })
                .catch((error) => { reject(error) })
            } catch (error) {
              reject(error)
            }
          }
          // window.fetch() requests. checkFetchStatus() appends responses.
          if (error.response) {
            error.response.text().then((body) => {
              error.message = error.message.concat(body)
              retry()
            })
          } else {
            retry()
          }
        })
    }
    if (previousError) {
      if (!isExpiredCredentialError(previousError)) { throw previousError }
      this.refreshAWSCredentials().then(callMyFun)
    } else {
      callMyFun()
    }
  })
}

module.exports = RequestUtil
