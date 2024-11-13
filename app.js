import express from 'express'
const app = express()

import https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
const __dirname = path.resolve()

import { Server } from 'socket.io'
import mediasoup from 'mediasoup'

app.get('*', (req, res, next) => {
  const path = '/sfu/'
  if (req.path.indexOf(path) == 0 && req.path.length > path.length) return next()
  res.send(`You need to specify a room name in the path e.g. 'https://127.0.0.1/sfu/room'`)
})

app.use('/sfu/:room', express.static(path.join(__dirname, 'public')))

const options = {
  key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8'),
  secureProtocol: 'TLS_method',
  ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256',
  honorCipherOrder: true,
}

const httpsServer = https.createServer(options, app)
httpsServer.listen(4010, () => {
  console.log('listening on port: ' + 4010)
})

const io = new Server(httpsServer)
const connections = io.of('/mediasoup')

let worker
let rooms = {}
let peers = {}
let transports = []
let producers = []
let consumers = []

const createWorker = async () => {
  try {
    worker = await mediasoup.createWorker({
      rtcMinPort: 2000,
      rtcMaxPort: 2020,
    })
    console.log(`worker pid ${worker.pid}`)

    worker.on('died', error => {
      console.error('mediasoup worker has died')
      setTimeout(() => process.exit(1), 2000)
    })
    
    return worker
  } catch (error) {
    console.error('Error creating worker:', error)
    throw error
  }
}

// Create worker immediately when application starts
(async () => {
  worker = await createWorker()
})()

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
]

connections.on('connection', async socket => {
  console.log('New connection:', socket.id)
  
  socket.emit('connection-success', {
    socketId: socket.id,
  })

  const removeItems = (items, socketId, type) => {
    const removedItems = items.filter(item => item.socketId === socketId)
    removedItems.forEach(item => {
      if (item[type]) {
        item[type].close()
      }
    })
    return items.filter(item => item.socketId !== socketId)
  }

  const cleanupPeer = (socketId) => {
    const peer = peers[socketId]
    if (!peer) return

    console.log('Cleaning up peer:', socketId)

    // Close all consumers
    peer.consumers.forEach(consumerId => {
      const consumerData = consumers.find(c => c.consumer.id === consumerId)
      if (consumerData && consumerData.consumer) {
        consumerData.consumer.close()
      }
    })

    // Close all producers
    peer.producers.forEach(producerId => {
      const producerData = producers.find(p => p.producer.id === producerId)
      if (producerData && producerData.producer) {
        producerData.producer.close()
      }
    })

    // Close all transports
    peer.transports.forEach(transportId => {
      const transportData = transports.find(t => t.transport.id === transportId)
      if (transportData && transportData.transport) {
        transportData.transport.close()
      }
    })

    // Remove from arrays
    consumers = consumers.filter(c => c.socketId !== socketId)
    producers = producers.filter(p => p.socketId !== socketId)
    transports = transports.filter(t => t.socketId !== socketId)

    // Remove from room
    if (peer.roomName && rooms[peer.roomName]) {
      rooms[peer.roomName].peers = rooms[peer.roomName].peers.filter(id => id !== socketId)
    }

    // Delete peer
    delete peers[socketId]
  }

  socket.on('disconnect', () => {
    console.log('Peer disconnected:', socket.id)
    cleanupPeer(socket.id)
  })

  socket.on('joinRoom', async ({ roomName }, callback) => {
    try {
      const router = await createRoom(roomName, socket.id)

      peers[socket.id] = {
        socket,
        roomName,
        transports: [],
        producers: [],
        consumers: [],
        peerDetails: {
          name: '',
          isAdmin: false,
        }
      }

      // Notify other peers in the room
      socket.to(roomName).emit('peer-joined', { socketId: socket.id })

      callback({ 
        rtpCapabilities: router.rtpCapabilities,
        peers: rooms[roomName].peers.filter(id => id !== socket.id) 
      })

    } catch (error) {
      console.error('Error joining room:', error)
      callback({ error: error.message })
    }
  })

  const createRoom = async (roomName, socketId) => {
    let router
    let peers = []

    if (rooms[roomName]) {
      router = rooms[roomName].router
      peers = rooms[roomName].peers
    } else {
      router = await worker.createRouter({ mediaCodecs })
    }

    rooms[roomName] = {
      router,
      peers: [...peers, socketId],
    }

    // Join socket.io room
    socket.join(roomName)

    return router
  }

  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    try {
      const peer = peers[socket.id]
      if (!peer) {
        throw new Error('Peer not found')
      }

      const router = rooms[peer.roomName].router
      const transport = await createWebRtcTransport(router)

      addTransport(transport, peer.roomName, consumer)

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      })
    } catch (error) {
      console.error('Error creating WebRTC transport:', error)
      callback({ error: error.message })
    }
  })

  const addTransport = (transport, roomName, consumer) => {
    transports.push({ 
      socketId: socket.id, 
      transport, 
      roomName, 
      consumer 
    })

    peers[socket.id].transports.push(transport.id)
  }

  const addProducer = (producer, roomName) => {
    producers.push({ 
      socketId: socket.id, 
      producer, 
      roomName 
    })

    peers[socket.id].producers.push(producer.id)
  }

  const addConsumer = (consumer, roomName) => {
    consumers.push({ 
      socketId: socket.id, 
      consumer, 
      roomName 
    })

    peers[socket.id].consumers.push(consumer.id)
  }

  socket.on('getProducers', async (callback) => {
    try {
      const peer = peers[socket.id]
      if (!peer) {
        throw new Error('Peer not found')
      }

      const producerList = producers
        .filter(p => p.socketId !== socket.id && p.roomName === peer.roomName)
        .map(p => ({
          producerId: p.producer.id,
          socketId: p.socketId
        }))

      callback(producerList)
    } catch (error) {
      console.error('Error getting producers:', error)
      callback({ error: error.message })
    }
  })

  const informConsumers = (roomName, socketId, producerId) => {
    // Notify all peers in the room except the producer
    socket.to(roomName).emit('new-producer', {
      producerId,
      socketId
    })
  }

  const getTransport = (socketId) => {
    const [transport] = transports.filter(t => 
      t.socketId === socketId && !t.consumer
    )
    return transport?.transport
  }

  socket.on('transport-connect', async ({ dtlsParameters }) => {
    try {
      const transport = getTransport(socket.id)
      if (!transport) {
        throw new Error('Transport not found')
      }
      await transport.connect({ dtlsParameters })
    } catch (error) {
      console.error('Error connecting transport:', error)
    }
  })

  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    try {
      const transport = getTransport(socket.id)
      if (!transport) {
        throw new Error('Transport not found')
      }

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData
      })

      const peer = peers[socket.id]
      addProducer(producer, peer.roomName)

      informConsumers(peer.roomName, socket.id, producer.id)

      producer.on('transportclose', () => {
        producer.close()
      })

      callback({
        id: producer.id,
        producersExist: producers.length > 1
      })
    } catch (error) {
      console.error('Error producing:', error)
      callback({ error: error.message })
    }
  })

  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    try {
      const transportData = transports.find(t => 
        t.consumer && t.transport.id === serverConsumerTransportId
      )
      if (!transportData) {
        throw new Error('Consumer transport not found')
      }

      await transportData.transport.connect({ dtlsParameters })
    } catch (error) {
      console.error('Error connecting receive transport:', error)
    }
  })

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {
      const peer = peers[socket.id]
      if (!peer) {
        throw new Error('Peer not found')
      }

      const router = rooms[peer.roomName].router
      const transportData = transports.find(t => 
        t.consumer && t.transport.id === serverConsumerTransportId
      )
      
      if (!transportData) {
        throw new Error('Consumer transport not found')
      }

      if (!router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        throw new Error('Cannot consume producer')
      }

      const consumer = await transportData.transport.consume({
        producerId: remoteProducerId,
        rtpCapabilities,
        paused: true,
      })

      consumer.on('transportclose', () => {
        consumer.close()
      })

      consumer.on('producerclose', () => {
        socket.emit('producer-closed', { remoteProducerId })
        consumer.close()
        consumers = consumers.filter(c => c.consumer.id !== consumer.id)
      })

      addConsumer(consumer, peer.roomName)

      callback({
        params: {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        }
      })
    } catch (error) {
      console.error('Error consuming:', error)
      callback({ error: error.message })
    }
  })

  socket.on('consumer-resume', async ({ serverConsumerId }) => {
    try {
      const consumerData = consumers.find(c => c.consumer.id === serverConsumerId)
      if (!consumerData) {
        throw new Error('Consumer not found')
      }

      await consumerData.consumer.resume()
    } catch (error) {
      console.error('Error resuming consumer:', error)
    }
  })
})

const createWebRtcTransport = async (router) => {
  try {
    const transport = await router.createWebRtcTransport({
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: '223.233.85.152', // Replace with your public IP
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    })

    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') {
        transport.close()
      }
    })

    transport.on('close', () => {
      console.log('Transport closed:', transport.id)
    })

    return transport
  } catch (error) {
    console.error('Error creating WebRTC transport:', error)
    throw error
  }
}
