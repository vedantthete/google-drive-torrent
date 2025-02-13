'use strict'

const driveCredentials = require('./data/driveCredentials.json')

const DRIVE_CLIENT_ID = driveCredentials.clientId
const DRIVE_CLIENT_SECRET = driveCredentials.clientSecret
const DRIVE_REDIRECT_URI = process.env.DRIVE_REDIRECT_URI || 'http://localhost:3000/login-callback'
const DRIVE_RETURN_FIELDS = 'id,name,webViewLink'
const DRIVE_TORRENT_DIR = 'My torrents'

const isProduction = process.env.NODE_ENV === 'production'

const torrentClients = {} // {userId: Webtorrent client}
const sockets = {} // {userId: socket}

const parseTorrent = require('parse-torrent')
const WebTorrent = require('webtorrent')
const cookieParser = require("cookie-parser");

const { google } = require('googleapis')
const express = require('express')
require('express-zip')
const helmet = require('helmet')
const { v4: uuidv4 } = require('uuid')
const forceHttps = require('express-force-https')
const bodyParser = require('body-parser')
const fileUpload = require('express-fileupload')
const fs = require('fs')
const path = require('path')
const os = require('os')
const locks = require('locks')
const _ = require('lodash')
const driveIO = require('google-drive-io')
const storage = require('node-persist');
storage.initSync();
const app = express()

const server = require('http').createServer(app)
const io = require('socket.io')(server)
const ios = require('socket.io-express-session')
const disk = require('diskusage');

const session = require('express-session')({
  secret: 'google-drive-torrent',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, maxAge: 3600000 }
})

app.set('port', (process.env.PORT || 3000))
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'pug')

app.use(express.static(path.join(__dirname, 'views')))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(fileUpload())
app.use(helmet())
app.use(session)
app.use(cookieParser());

if (isProduction) {
  app.use(forceHttps)
}

io.use(ios(session))
io.on('connection', (socket) => {
  const session = socket.handshake.session
  if ('user' in session) {
    const user = session.user
    sockets[user.id] = socket
    resumeTorrentsForSession(session)
    // send updates every second
    const updateInterval = 2000
    sendUpdate(user, socket)
    const updateTask = setInterval(() => sendUpdate(user, socket), updateInterval)

    // stop updates when user disconnects
    socket.on('disconnect', () => clearInterval(updateTask))
  }
})

/* PART I: Routes for views */
app.get('/', (req, res) => {
  loggedIn(req) ? res.redirect('/dashboard') : res.redirect('/home')
})

app.get('/home', (req, res) => {
  unlessLoggedIn(req, res, () => {
    tryLogin(req, res).then((tokens) => {
      res.cookie(
        'tokens', JSON.stringify(tokens),
        {
          maxAge: 20 * 600 * 600 * 100000000,
          httpOnly: true
        }
      )
      res.redirect('/dashboard')
    }).catch(() => {
      const options = {}
      if ('error' in req.query) {
        options.error = req.query.error
      }
      res.render('index.pug', options)
    })
  })
})

app.get('/dashboard', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const driveUrl = req.session.driveUrl
    res.render('dashboard.pug', {
      name: user.names[0].displayName,
      firstName: user.names[0].givenName,
      pic: user.photos[0].url,
      driveUrl
    })
  })
})

/* PART II: Routes for authentication */
// Login to Google
app.get('/login', (req, res) => {
  unlessLoggedIn(req, res, () => {
    tryLogin(req, res)
      .then((tokens) => {
        res.cookie(
          'tokens', JSON.stringify(tokens),
          {
            maxAge: 20 * 600 * 600 * 100000000,
            httpOnly: true
          }
        )
        res.redirect('/dashboard')
      })
      .catch(() => {
        const url = newOAuth2Client().generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [
            'https://www.googleapis.com/auth/plus.me',
            "https://www.googleapis.com/auth/drive.metadata.readonly",
            "https://www.googleapis.com/auth/drive.metadata.readonly",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/drive.file",
            'profile'
            //'https://www.googleapis.com/auth/drive',
          ]
        })
        res.redirect(url)
      })
  })
})


// Accept authorisation code from Google
app.get('/login-callback', (req, res) => {
  unlessLoggedIn(req, res, () => {
    // Redirect to home page and display error message if authentication failure
    if ('error' in req.query) {
      console.error(`Login error: ${req.query.error}`)
      return res.redirect('/error')
    }

    // Otherwise proceed, get tokens and save auth client and user details
    const code = req.query.code
    const oAuth2Client = newOAuth2Client()
    oAuth2Client.getToken(code, (err, tokens) => {
      if (err) {
        console.error(`OAuth2 failed: ${err}`)
        return res.redirect('/error')
      }

      // store access and refresh tokens in session
      req.session.tokens = tokens
      res.cookie(
        'tokens', JSON.stringify(tokens),
        {
          maxAge: 20 * 600 * 600 * 100000000,
          httpOnly: true
        }
      )
      oAuth2Client.setCredentials(tokens)

      google.people('v1').people.get({
        auth: oAuth2Client,
        resourceName: 'people/me',
        personFields: 'names,photos,metadata'
      }, (err, data) => {
        if (err) {
          console.error(`Failed to get user details: ${err}`)
          return res.redirect('/error')
        }
        const user = data.data
        user.id = user.metadata.sources[0].id
        req.session.user = user
        console.log(`Obtained user: ${JSON.stringify(user)}`)

        driveIO.createFolderIfNotExists(DRIVE_TORRENT_DIR, DRIVE_RETURN_FIELDS, oAuth2Client)
          .then(folder => {
            req.session.driveUrl = folder.webViewLink
            return res.redirect('/dashboard')
          })
          .catch(err => {
            console.error(`Failed to create google drive folder: ${err}`)
            return res.redirect('/error')
          })
      })
    })
  })
})

app.get('/logout', (req, res) => {
  ifLoggedIn(req, res, () => {
    delete req.session.oAuth2Client
    delete req.session.user
    res.clearCookie("tokens")
    res.redirect('/home')
  })
})

/* PART III: Routes for torrent interaction */
app.post('/add-torrent', (req, res) => {
  ifLoggedIn(req, res, () => {
    // extract torrent from post request
    let torrentId = null
    if ('files' in req && 'torrent' in req.files) {
      torrentId = req.files.torrent.data
    } else if ('body' in req && 'magnet' in req.body) {
      torrentId = req.body.magnet
    } else {
      return res.status(500).json({ message: 'Invalid request in parse-torrent' })
    }

    const user = req.session.user
    const oAuth2Client = newOAuth2Client(req.session.tokens)
    const torrent = addTorrentForUser(torrentId, user, (err, torrent) => {
      if (err) {
        return res.status(500).json({ message: err.message })
      }
      console.log(`Added torrent: ${torrent.name} with files ${torrent.files.map(f => f.name).join(', ')}`)
      storage.setItem(`${user.id}-${torrent.infoHash}`, torrentId)
      const torrentFiles = {
        infoHash: torrent.infoHash,
        files: getFileInfos(torrent)
      }
      return res.json(torrentFiles)
    })

    const socket = getSocketForUser(user)

    // Add callback handlers so that files get uploaded to google drive once ready
    torrent.once('ready', () => {
      console.log(`Torrent ${torrent.infoHash} is ready`)
      attachCompleteHandler(torrent, oAuth2Client, socket)
    })

    torrent.on('warning', (err) => {
      console.warn('Torrent on warning: ' + err)
      socket.emit('torrent-warning', {
        message: err.message
      })
    })

    torrent.on('error', (err) => {
      torrent.error = err.message // Attach error onto torrent (hack!)
      const info = getTorrentInfo(torrent)
      socket.emit('torrent-error', info)
      socket.emit('torrent-update', info)
      console.error('Torrent on error: ' + err)
    })
  })
})

app.post('/pause-torrent', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const infoHash = req.body.infoHash

    const torrent = getTorrentForUser(infoHash, user)
    for (let i = 0; i < torrent.files.length; i++) {
      const file = torrent.files[i]
      if (file.selected){
        file.selected = false
        file.deselect()
        file.paused = true
      }
    }
    torrent.customPaused = true
    res.end()
  })
})

app.post('/resume-torrent', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const infoHash = req.body.infoHash

    const torrent = getTorrentForUser(infoHash, user)
    for (let i = 0; i < torrent.files.length; i++) {
      const file = torrent.files[i]
      if (file.paused){
        file.selected = true
        file.select()
        file.paused = false
      }
    }
    torrent.customPaused = false
    res.end()
  })
})

app.post('/update-torrent', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const infoHash = req.body.infoHash
    const selectedFiles = req.body.selectedFiles // array of booleans

    const torrent = getTorrentForUser(infoHash, user)

    // Needed as a workaround since deselect() doesn't work on its own - https://github.com/webtorrent/webtorrent/issues/164#issuecomment-248395202
    torrent.deselect(0, torrent.pieces.length - 1, false)

    // deselect files based on user choice
    for (let i = 0; i < torrent.files.length; i++) {
      const file = torrent.files[i]
      const newSelection = selectedFiles[i] === 'true' // somehow selectedFiles are received as strings, need to parse

      if (newSelection) {
        // file selected
        if (!file.selected){
          file.select()
          file.selected = true // attach to file object (hack!) to retrieve later
        }
        console.log(`Selected file: ${file.name} for user ${user.id}`)
      } else {
        // file deselected
        file.deselect()
        file.selected = false // attach to file object (hack!) to retrieve later
        console.log(`Deselected file: ${file.name} for user ${user.id}`)
      }
    }
    res.end()
  })
})

app.post('/delete-torrent', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const infoHash = req.body.infoHash

    const client = torrentClients[user.id]
    if (!client) {
      return res.status(500).json({ message: 'Client not found for user' })
    }
    storage.removeItem(`${user.id}-${infoHash}`)
    client.remove(infoHash, (err) => {
      if (err) {
        return res.status(500).json({ message: err.message })
      }
      console.log(`Deleted torrent: ${infoHash}`)
      return res.end()
    })
  })
})

app.get('/get-torrents', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const client = torrentClients[user.id]
    if (!client) {
      // return empty array if client is not yet initialised
      res.json([]); return
    }
    const torrentsInfo = getTorrentsInfo(client.torrents)
    res.json(torrentsInfo)
  })
})

app.get('/download/:infoHash', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const infoHash = req.params.infoHash
    const torrent = getTorrentForUser(infoHash, user)
    const files = getSelectedFiles(torrent)

    const targets = files.map((file) => {
      return { name: file.name, path: file.path }
    })
    res.zip(targets, `${torrent.name}.zip`)
  },
    () => {
      const infoHash = req.params.infoHash
      for (let k in torrentClients) {
        if (torrentClients[k].get(infoHash) != null) {
          const torrent = torrentClients[k].get(infoHash)
          const files = getSelectedFiles(torrent)
          const targets = files.map((file) => {
            return { name: file.name, path: file.path }
          })
          res.zip(targets, `${torrent.name}.zip`)
          break
        }
      }
    }
  )
})

app.get('/download/:infoHash/:fileId', (req, res) => {
  ifLoggedIn(req, res, () => {
    const user = req.session.user
    const infoHash = req.params.infoHash
    const fileId = req.params.fileId
    const torrent = getTorrentForUser(infoHash, user)

    const file = torrent.files.find((file) => file.fileId === fileId)
    res.download(file.path, file.name)
  },
    () => {
      const infoHash = req.params.infoHash
      const fileId = req.params.fileId
      for (let k in torrentClients) {
        if (torrentClients[k].get(infoHash) != null) {
          const torrent = torrentClients[k].get(infoHash)
          const file = torrent.files.find((file) => file.fileId === fileId)
          res.download(file.path, file.name)
          break
        }
      }
    }
  )
})

app.get('*', (req, res) => {
  res.render('error.pug')
})

server.listen(app.get('port'), () => {
  console.log('Node app is running on port', app.get('port'))
})

const tryLogin = (req, res) => {
  return new Promise((resolve, reject) => {
    let tokens = req.cookies.tokens
    if (tokens == undefined) {
      reject()
    }
    tokens = JSON.parse(tokens)
    const oAuth2Client = newOAuth2Client(tokens)
    oAuth2Client.credentials = tokens
    google.people('v1').people.get({
      auth: oAuth2Client,
      resourceName: 'people/me',
      personFields: 'names,photos,metadata'
    }, (err, data) => {
      if (err) {
        console.error(`Failed to get user details: ${err}`)
        reject()
      } else {
        const user = data.data
        user.id = user.metadata.sources[0].id
        req.session.user = user
        req.session.tokens = oAuth2Client.credentials
        console.log(`Obtained user: ${JSON.stringify(user)}`)
        driveIO.createFolderIfNotExists(DRIVE_TORRENT_DIR, DRIVE_RETURN_FIELDS, oAuth2Client)
          .then(folder => {
            req.session.driveUrl = folder.webViewLink
            // return res.redirect('/dashboard')
            resolve(oAuth2Client.credentials)
          })
          .catch(err => {
            console.error(`Failed to create google drive folder: ${err}`)
            resolve(oAuth2Client.credentials)
            // return res.redirect('/error')
          })

      }
    })
  })
}

/* Helper functions */
const resumeTorrentsForSession = (session) => {
  const user = session.user
  storage.keys().then(keys => {
    for (let key of keys) {
      storage.getItem(key).then(value => {
        if (key.split('-')[0] == user.id) {
          const oAuth2Client = newOAuth2Client(session.tokens)
          const torrent = addTorrentForUser(value, user, (err, torrent) => {
            if (err) {
              return
            }
            console.log(`Added torrent: ${torrent.name} with files ${torrent.files.map(f => f.name).join(', ')}`)
          })
          if (torrent == undefined) {
            return
          }
          const socket = getSocketForUser(user)

          // Add callback handlers so that files get uploaded to google drive once ready
          torrent.once('ready', () => {
            console.log(`Torrent ${torrent.infoHash} is ready`)
            attachCompleteHandler(torrent, oAuth2Client, socket)
          })

          torrent.on('warning', (err) => {
            console.warn('Torrent on warning: ' + err)
            socket.emit('torrent-warning', {
              message: err.message
            })
          })

          torrent.on('error', (err) => {
            torrent.error = err.message // Attach error onto torrent (hack!)
            if (err.message.indexOf('duplicate') > -1) {
              return
            }
            const info = getTorrentInfo(torrent)
            socket.emit('torrent-error', info)
            socket.emit('torrent-update', info)
            console.error('Torrent on error: ' + err)
          })
        }
      })
    }
  })
}

const loggedIn = (req) => {
  return 'tokens' in req.session && 'user' in req.session
}

const ifLoggedIn = (req, res, callback, otherwise) => {
  if (!otherwise) {
    otherwise = () => {
      res.redirect('/home')
    }
  }
  loggedIn(req) ? callback() : otherwise()
}

const unlessLoggedIn = (req, res, callback, otherwise) => {
  if (!otherwise) {
    otherwise = () => {
      res.redirect('/dashboard')
    }
  }
  loggedIn(req) ? otherwise() : callback()
}

const newOAuth2Client = (tokens) => {
  const oAuth2Client = new google.auth.OAuth2(
    DRIVE_CLIENT_ID,
    DRIVE_CLIENT_SECRET,
    DRIVE_REDIRECT_URI
  )
  if (tokens) {
    oAuth2Client.setCredentials(tokens)
  }
  return oAuth2Client
}

/**
 * Adds a new torrent for the user (creating a new Webtorrent Client if neccessary),
 *  returns the added torrent and invokes callback(err, torrent).
 * @param  torrent anything Webtorrent identifies as a torrent (infoHash/magnetURI/.torrent etc)
 * @param  user Google Plus API user object
 * @param  callback(err, torrent)
 * @return reference to Webtorrent torrent object
 */
const addTorrentForUser = (torrent, user, callback) => {
  const client = (user.id in torrentClients) ? torrentClients[user.id] : new WebTorrent({ maxConns: 2000 })
  torrentClients[user.id] = client
  let diskStats = disk.checkSync('/');
  console.log(diskStats);
  if ((diskStats.available / diskStats.total) < 0.1) {
    console.log("No space on device")
    callback({})
    return undefined
  }
  try {
    const parsedTorrent = parseTorrent(torrent)
    const infoHash = parsedTorrent.infoHash
    console.log(`Parsed infohash: ${infoHash}`)

    // Catch error in case client.add() later fails
    const callbackWithError = (err) => {
      callback(err)
    }

    const saveToPath = path.join(os.tmpdir(), user.id, infoHash)
    console.log(`Torrent ${infoHash} will be saved to: ${saveToPath}`)
    const torrentHandle = client.add(torrent, {
      path: saveToPath,
      destroyStoreOnDestroy: true, // Delete the torrent's chunk store (e.g. files on disk) when the torrent is destroyed
      storeCacheSlots: 0 // Number of chunk store entries (torrent pieces) to cache in memory [default=20]; 0 to disable caching
    }, (torrent) => {
      if (torrent.length >= diskStats.available) {
        storage.removeItem(`${user.id}-${infoHash}`)
        client.remove(torrent, (err) => {
          if (err) {
            console.log(err)
          }
          console.log('removed torrent due to low disk space')
        })
      }
      torrentHandle.removeListener('error', callbackWithError)

      for (let i = 0; i < torrent.files.length; i++) {
        // Attach boolean to file (hack!), by default all files are selected
        torrent.files[i].selected = true
        // Attach unique id to file (hack!), to support direct downloads
        torrent.files[i].fileId = uuidv4()
      }
      callback(null, torrent)
    })

    torrentHandle.once('error', callbackWithError)

    return torrentHandle
  } catch (err) {
    callback(err)
  }
}

const getTorrentForUser = (torrent, user) => {
  const client = torrentClients[user.id]
  return client.get(torrent)
}

const getSocketForUser = (user) => {
  return sockets[user.id]
}

const getFileInfos = (torrent) => {
  return torrent.files.map((f) => {
    return {
      name: f.name,
      fileId: f.fileId,
      length: f.length,
      downloaded: f.downloaded,
      progress: f.progress,
      selected: f.selected,
      driveId: f.driveId
    }
  })
}

const getTorrentInfo = (torrent) => {
  return getTorrentsInfo([torrent])
}

const getTorrentsInfo = (torrents) => {
  let diskStats = disk.checkSync('/');
  return torrents.map((torrent) => {
    const files = getSelectedFiles(torrent)
    const received = _.sumBy(files, (file) => file.downloaded)
    const size = _.sumBy(files, (file) => file.length)
    const progress = Math.min(received / size, 1)

    return {
      infoHash: torrent.infoHash,
      magnetURI: torrent.magnetURI,
      name: torrent.name,
      files: getFileInfos(torrent),
      received,
      size,
      progress,
      timeRemaining: torrent.timeRemaining,
      downloaded: torrent.downloaded,
      downloadSpeed: torrent.downloadSpeed,
      uploaded: torrent.uploaded,
      uploadSpeed: torrent.uploadSpeed,
      ratio: torrent.ratio,
      numPeers: torrent.numPeers,
      error: torrent.error,
      driveUrl: torrent.driveUrl,
      diskAvailable: `${Math.floor(diskStats.available / 1000000)} MB`,
      customPaused: torrent.customPaused
    }
  })
}

const getSelectedFiles = (torrent) => {
  return torrent.files.filter((file) => file.selected)
}

const torrentIsDone = (torrent) => {
  return _.every(getSelectedFiles(torrent), file => file.done)
}

const attachCompleteHandler = (torrent, auth, socket) => {
  const mutex = locks.createMutex() // prevent race condition during google drive operations

  torrent.files.forEach((file) => {
    file.on('done', () => {
      // Update torrent as success if all files have completed
      console.log(`Done for file: ${file.path}`)
      let torrentFolderPath = path.join(DRIVE_TORRENT_DIR, torrent.name)
      torrentFolderPath = torrentFolderPath.replace("'", "")
      let uploadPath = path.join(DRIVE_TORRENT_DIR, path.relative(torrent.path, file.path))
      uploadPath = uploadPath.replace("'", "")
      if (torrentIsDone(torrent) && (torrentFolderPath != uploadPath)) {
        mutex.lock(() => {
          driveIO.createFolderIfNotExists(torrentFolderPath, DRIVE_RETURN_FIELDS, auth)
            .then(torrentFolder => {
              torrent.driveUrl = torrentFolder.webViewLink
              socket.emit('torrent-success', getTorrentInfo(torrent))
              console.log(`Created torrent folder on google drive: ${torrent.name}`)
            })
            .catch(err => {
              console.error(err)
              torrent.error = err.message
              socket.emit('torrent-error', getTorrentInfo(torrent))
            })
            .finally(() => {
              mutex.unlock()
            })
        })
      }
      if (file.selected) {
        let uploadPath = path.join(DRIVE_TORRENT_DIR, path.relative(torrent.path, file.path))
        uploadPath = uploadPath.replace("'", "")
        console.log(`Directory: ${torrent.path} exists: ${fs.existsSync(torrent.path)}`)
        console.log(`File: ${file.path} exists: ${fs.existsSync(file.path)}`)
        mutex.lock(() => {
          driveIO.uploadFileIfNotExists(file.path, uploadPath, DRIVE_RETURN_FIELDS, auth)
            .then(uploaded => {
              file.driveId = uploaded.id
              socket.emit('torrent-update', getTorrentInfo(torrent))
              // let torrentInfo = [{ name: `File uploaded to google drive: ${uploadPath}, with id: ${uploaded.id}`, size: 0 }]
              // socket.emit('torrent-success', torrentInfo)
              console.log(`File uploaded to google drive: ${uploadPath}, with id: ${uploaded.id}`)
              // setTimeout(
              //   () => {
              //     file.deselect()
              //     file.selected = false
              //     fs.unlink(file.path, () => console.log('DELETED FILE =>>>>', file.path))
              //   }, 10000
              // )
            })
            .catch(err => {
              console.error(err)
              torrent.error = err.message
              socket.emit('torrent-error', getTorrentInfo(torrent))
            })
            .finally(() => {
              mutex.unlock()
            })
        })
      }
    })
  })
}

const sendUpdate = (user, socket) => {
  const client = torrentClients[user.id]
  if (!client) {
    return socket.emit('all-torrents', [])
  }
  socket.emit('all-torrents', getTorrentsInfo(client.torrents))
}
