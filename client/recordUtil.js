'use strict'

const proto = require('./constants/proto')
const serializer = require('../lib/serializer')
const valueEquals = require('../lib/valueEquals')

/**
 * @param {string} type e.g. 'historySite'
 * @param {Function} isValidRecord checks if the update record has enough props to make a create record
 * @param {Function} mapUpdateToCreate converts props from the update record to the create record
 * @returns {Function}
 */
const CreateFromUpdate = (type, isValidRecord, mapUpdateToCreate) => {
  if (!type || !isValidRecord || !mapUpdateToCreate) {
    throw new Error('type, isValidRecord, mapUpdateToCreate are required args')
  }
  return (record) => {
    if (!record[type]) { throw new Error(`Record missing ${type}`) }
    if (!isValidRecord(record)) { return null }
    const resolvedTypeProps = mapUpdateToCreate(record[type])
    return Object.assign(
      record,
      { action: proto.actions.CREATE, [type]: resolvedTypeProps }
    )
  }
}

const createSitePropsFromUpdateSite = (site) => {
  const defaultProps = {
    title: '',
    customTitle: site.location,
    lastAccessedTime: Date.now(),
    creationTime: Date.now()
  }
  return Object.assign({}, defaultProps, site)
}

const createFromUpdateBookmark = CreateFromUpdate(
  'bookmark',
  (record) => {
    return (record.bookmark.site && (
      record.bookmark.site.location ||
      (record.bookmark.site.customTitle && record.bookmark.folderId && record.bookmark.folderId > 0)
    ))
  },
  (bookmark) => {
    if (bookmark.folderId && bookmark.folderId > 0) {
      return Object.assign({isFolder: true}, bookmark)
    } else {
      const defaultProps = {
        isFolder: false
      }
      const site = createSitePropsFromUpdateSite(bookmark.site)
      return Object.assign({}, defaultProps, bookmark, {site})
    }
  }
)

const createFromUpdateHistorySite = CreateFromUpdate(
  'historySite',
  (record) => { return !!record.historySite.location },
  createSitePropsFromUpdateSite
)

const createFromUpdateSiteSetting = CreateFromUpdate(
  'siteSetting',
  (record) => { return !!record.siteSetting.hostPattern },
  (siteSetting) => { return siteSetting }
)

module.exports.createFromUpdate = (record) => {
  if (!record || record.action !== proto.actions.UPDATE) {
    throw new Error('Missing UPDATE syncRecord.')
  }
  switch (record.objectData) {
    case 'bookmark':
      return createFromUpdateBookmark(record)
    case 'historySite':
      return createFromUpdateHistorySite(record)
    case 'siteSetting':
      return createFromUpdateSiteSetting(record)
    default:
      console.log(`Warning: invalid objectData ${record.objectData}`)
      return null
  }
}

/**
 * Given a new SyncRecord and a browser's matching existing object if available,
 * resolve the write to perform on the browser's data.
 * @param {Object} record syncRecord as a JS object
 * @param {Object=} existingObject Browser object as syncRecord JS object
 * @returns {Object} Resolved syncRecord to apply to browser data
 */
module.exports.resolve = (record, existingObject) => {
  if (!record) { throw new Error('Missing syncRecord JS object.') }
  const nullIgnore = () => {
    console.log(`Ignoring ${record.action} of object ${record.objectId}.`)
    return null
  }
  switch (record.action) {
    case proto.actions.CREATE:
      if (existingObject) {
        return nullIgnore()
      } else {
        return record
      }
    case proto.actions.UPDATE:
      if (existingObject) {
        if (valueEquals(record[record.objectData],
          existingObject[existingObject.objectData])) {
          return nullIgnore()
        }
        return record
      } else {
        return this.createFromUpdate(record) || nullIgnore()
      }
    case proto.actions.DELETE:
      if (existingObject) {
        return record
      } else {
        return nullIgnore()
      }
    default:
      throw new Error(`Invalid record action: ${record.action}`)
  }
}

/**
 * Given a SyncRecord protobuf object, convert to a basic JS object.
 * @param {Serializer.api.SyncRecord}
 * @returns {Object}
 */
module.exports.syncRecordAsJS = (record) => {
  /* We should be able to call asJSON({defaults: true}) but it doesn't work.
   * I think it's because objectData is a oneof.
   * .asJSON() options:
   * http://dcode.io/protobuf.js/global.html#JSONConversionOptions
   */
  let object = record.asJSON()
  object.action = record.action
  const objectData = serializer.getSyncRecordObjectData(record)
  object.objectData = objectData
  object[objectData] = record[objectData].asJSON({defaults: true, enums: Number, longs: Number})
  return object
}
