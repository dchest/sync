const test = require('tape')
const testHelper = require('../testHelper')
const timekeeper = require('timekeeper')
const proto = require('../../client/constants/proto')
const recordUtil = require('../../client/recordUtil')
const Serializer = require('../../lib/serializer')

test('recordUtil.resolve', (t) => {
  t.plan(7)
  const Record = (props) => {
    const baseProps = {
      action: proto.actions.CREATE,
      deviceId: new Uint8Array([0]),
      objectId: testHelper.uuid()
    }
    return Object.assign({}, baseProps, props)
  }
  const UpdateRecord = (props) => {
    return Record(Object.assign({action: proto.actions.UPDATE}, props))
  }

  const timestampMs = 1480004209001
  const siteProps = {
    location: 'https://www.jisho.org',
    title: 'jisho',
    customTitle: '辞書',
    lastAccessedTime: timestampMs,
    creationTime: timestampMs
  }
  const props = {
    bookmark: {
      isFolder: false,
      site: siteProps
    },
    historySite: siteProps,
    siteSetting: {
      fingerprintingProtection: false,
      hostPattern: 'https?://soundcloud.com',
      shieldsUp: false, // yolo
      noScript: false,
      zoomLevel: 2.5
    }
  }
  const updateSiteProps = {customTitle: 'a ball pit filled with plush coconuts'}

  const recordBookmark = Record({objectData: 'bookmark', bookmark: props.bookmark})
  const recordHistorySite = Record({objectData: 'historySite', historySite: siteProps})
  const recordSiteSetting = Record({objectData: 'siteSetting', siteSetting: props.siteSetting})
  const baseRecords = [recordBookmark, recordHistorySite, recordSiteSetting]

  const updateBookmark = UpdateRecord({objectData: 'bookmark', bookmark: {site: updateSiteProps}})
  const updateHistorySite = UpdateRecord({objectData: 'historySite', historySite: updateSiteProps})
  const updateSiteSetting = UpdateRecord({objectData: 'siteSetting', siteSetting: {shieldsUp: true}})

  const forRecordsWithAction = (t, action, callback) => {
    t.plan(baseRecords.length)
    for (let record of baseRecords) {
      record.action = action
      const existingObject = Object.assign({}, record, {action: proto.actions.CREATE})
      callback(record, existingObject)
    }
  }

  t.test('CREATE, existing object -> null', (t) => {
    forRecordsWithAction(t, proto.actions.CREATE, (record, existingObject) => {
      const resolved = recordUtil.resolve(record, existingObject)
      t.equals(resolved, null, `${t.name}: ${record.objectData}`)
    })
  })

  t.test('CREATE, no existing object -> identity', (t) => {
    forRecordsWithAction(t, proto.actions.CREATE, (record) => {
      const resolved = recordUtil.resolve(record, undefined)
      t.equals(resolved, record, `${t.name}: ${record.objectData}`)
    })
  })

  t.test('DELETE, existing object -> identity', (t) => {
    forRecordsWithAction(t, proto.actions.DELETE, (record, existingObject) => {
      const resolved = recordUtil.resolve(record, existingObject)
      t.equals(resolved, record, `${t.name}: ${record.objectData}`)
    })
  })

  t.test('DELETE, no existing object -> null', (t) => {
    forRecordsWithAction(t, proto.actions.DELETE, (record) => {
      const resolved = recordUtil.resolve(record, undefined)
      t.equals(resolved, null, `${t.name}: ${record.objectData}`)
    })
  })

  t.test('UPDATE, existing object with same props -> null', (t) => {
    forRecordsWithAction(t, proto.actions.UPDATE, (record, existingObject) => {
      const resolved = recordUtil.resolve(record, existingObject)
      t.equals(resolved, null, `${t.name}: ${record.objectData}`)
    })
  })

  t.test('UPDATE, existing object with different props -> identity', (t) => {
    t.plan(3)
    const resolvedBookmark = recordUtil.resolve(updateBookmark, recordBookmark)
    t.equals(resolvedBookmark, updateBookmark, `${t.name}: bookmark`)
    const resolvedHistorySite = recordUtil.resolve(updateHistorySite, recordHistorySite)
    t.equals(resolvedHistorySite, updateHistorySite, `${t.name}: historySite`)
    const resolvedSiteSetting = recordUtil.resolve(updateSiteSetting, recordSiteSetting)
    t.equals(resolvedSiteSetting, updateSiteSetting, `${t.name}: siteSetting`)
  })

  t.test('UPDATE, no existing object', (t) => {
    t.plan(7)
    const time = 1480000000 * 1000
    const url = 'https://jisho.org'

    const resolveToNull = (t, recordProps, message) => {
      t.plan(1)
      const record = Record(
        Object.assign({}, recordProps, {action: proto.actions.UPDATE})
      )
      const resolvedRecord = recordUtil.resolve(record)
      t.equals(resolvedRecord, null, message)
    }

    const resolveToCreate = (t, recordProps, resolvedProps, message) => {
      t.plan(1)
      const record = Record(
        Object.assign({}, recordProps, {action: proto.actions.UPDATE})
      )
      const expectedRecord = Record(Object.assign(
        {},
        resolvedProps,
        {
          action: proto.actions.CREATE,
          deviceId: record.deviceId,
          objectId: record.objectId
        }
      ))

      timekeeper.freeze(time)
      const resolvedRecord = recordUtil.resolve(record)
      timekeeper.reset()
      t.deepEquals(resolvedRecord, expectedRecord, message)
    }

    t.test(`${t.name}, historySite, .customTitle -> null`, (t) => {
      const recordProps = {objectData: 'historySite', historySite: {customTitle: 'pyramid'}}
      resolveToNull(t, recordProps, t.name)
    })

    t.test(`${t.name}, historySite, .location -> create`, (t) => {
      const recordProps = {objectData: 'historySite', historySite: {location: url}}
      const resolvedProps = {
        historySite: {
          location: url,
          title: '',
          customTitle: url,
          lastAccessedTime: time,
          creationTime: time
        },
        objectData: 'historySite'
      }
      resolveToCreate(t, recordProps, resolvedProps, t.name)
    })

    t.test(`${t.name}, bookmark, .site.customTitle -> null`, (t) => {
      const recordProps = {
        objectData: 'bookmark',
        bookmark: {site: {customTitle: 'i like turtles'}}
      }
      resolveToNull(t, recordProps, t.name)
    })

    t.test(`${t.name}, bookmark, .site.location -> create bookmark`, (t) => {
      const recordProps = {
        objectData: 'bookmark',
        bookmark: {site: {location: url}}
      }
      const resolvedProps = {
        bookmark: {
          site: {
            location: url,
            title: '',
            customTitle: url,
            lastAccessedTime: time,
            creationTime: time
          },
          isFolder: false
        },
        objectData: 'bookmark'
      }
      resolveToCreate(t, recordProps, resolvedProps, t.name)
    })

    t.test(`${t.name}, bookmark, .folderId .site.customTitle -> create folder`, (t) => {
      const recordProps = {
        objectData: 'bookmark',
        bookmark: {folderId: 1, site: {customTitle: 'sweet title'}}
      }
      const resolvedProps = {
        bookmark: {
          site: {customTitle: 'sweet title'},
          isFolder: true,
          folderId: 1
        },
        objectData: 'bookmark'
      }
      resolveToCreate(t, recordProps, resolvedProps, t.name)
    })

    t.test(`${t.name}, siteSetting, .safeBrowsing -> null`, (t) => {
      const recordProps = {
        objectData: 'siteSetting',
        siteSetting: {safeBrowsing: false}
      }
      resolveToNull(t, recordProps, t.name)
    })

    t.test(`${t.name}, siteSetting, .hostPattern -> create`, (t) => {
      const recordProps = {
        objectData: 'siteSetting',
        siteSetting: {hostPattern: url, noScript: false}
      }
      const resolvedProps = {
        siteSetting: {
          hostPattern: url,
          noScript: false
        },
        objectData: 'siteSetting'
      }
      resolveToCreate(t, recordProps, resolvedProps, t.name)
    })
  })
})

test('recordUtil.syncRecordAsJS()', (t) => {
  t.plan(4)
  Serializer.init().then((serializer) => {
    const time = 1480000000 * 1000
    const baseProps = {
      action: proto.actions.CREATE,
      deviceId: new Uint8Array([0]),
      objectId: testHelper.uuid()
    }
    const conversionEquals = (recordProps) => {
      const props = Object.assign({}, baseProps, recordProps)
      const encodedRecord = serializer.api.SyncRecord.encode(props).finish()
      const decodedRecord = serializer.api.SyncRecord.decode(encodedRecord)
      const recordJS = recordUtil.syncRecordAsJS(decodedRecord)
      t.deepEquals(recordJS, props, `${t.name} ${recordProps.objectData}`)
    }

    const site = serializer.api.SyncRecord.Site.create({
      creationTime: time,
      customTitle: 'cool',
      lastAccessedTime: time,
      location: 'https://jisho.org',
      title: 'jisho'
    })
    conversionEquals({ objectData: 'historySite', historySite: site })

    const bookmark = serializer.api.SyncRecord.Bookmark.create({
      site,
      isFolder: false,
      folderId: 0,
      parentFolderId: 0
    })
    conversionEquals({ objectData: 'bookmark', bookmark })

    // All params are required because protobufs assume undefined == default value
    const siteSetting = serializer.api.SyncRecord.SiteSetting.create({
      adControl: 0, cookieControl: 0, fingerprintingProtection: false, hostPattern: 'https://jisho.org', httpsEverywhere: false, ledgerPayments: false, ledgerPaymentsShown: false, noScript: false, safeBrowsing: false, shieldsUp: false, zoomLevel: 0.5
    })
    conversionEquals({ objectData: 'siteSetting', siteSetting })

    const device = serializer.api.SyncRecord.Device.create({
      name: 'mobile pyramid'
    })
    conversionEquals({ objectData: 'device', device })
  })
})
