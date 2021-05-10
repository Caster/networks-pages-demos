// --- libraries ---------------------------------------------------------------
const _ = require('underscore');
const ejs = require('ejs');
const formBody = require('body/form');
const fs = require('fs');
const http = require('http');
const mime = require('mime-types');
const path = require('path');
const url = require('url');


// --- constants ---------------------------------------------------------------
const IS_PASSENGER = (typeof(PhusionPassenger) !== 'undefined');
const MAX_DEGREE = 5;
const STANDALONE = (process.env.STANDALONE === 'true' || IS_PASSENGER);
const SURVIVAL_P = 0.5;
const URL_PREFIX = '/percolation-game';


// --- globals -----------------------------------------------------------------
const db = require('./db');
const logger = require('./logging');
const rooms = new Map();


// --- functions ---------------------------------------------------------------
function _addnode(req, url, res) {
  const ip = getIP(req);
  const data = url.searchParams;
  const id = (data.has('id') ? parseInt(data.id, 10) : false);
  const roomPath = data.get('room', false);

  for (let param of ['name', 'neighbor1', 'neighbor2']) {
    if (!data.has(param)) {
      return res.writeHead(400, {
        message: `Please provide ${param}.`,
        errorfield: param
      }).end();
    }
  }

  try {
    _addnode_internal(ip, data.get('name'), parseInt(data.get('neighbor1'), 10),
                      parseInt(data.get('neighbor2'), 10), id, roomPath);
  } catch (errorMessage) {
      return res.writeHead(400, {
        message: errorMessage,
        errorfield: false
      }).end();
  }

  return res.end('okay');
}
function _addnode_internal(ip, name, n1Idx, n2Idx, id = false, roomPath = false) {
  // check if room exists
  if (!rooms.has(roomPath)) {
    throw 'Room not found.';
  }
  const room = rooms.get(roomPath);

  // check if percolation has started
  if (room.percolationResult) {
    throw 'Cannot add nodes anymore, percolation has started.';
  }

  // check if name is given
  if (typeof name !== 'string' || name.trim() === '')
    throw 'Please specify a name for your node.'

  // check if ip is unique
  let ipUnique = true;
  room.nodes.forEach(function (n) {
    if (n.ip == ip) ipUnique = false;
  });
  if (!ipUnique && id === false) {
    throw 'You have already added a node to the network.';
  }

  // define ID for the new node
  let newIDi;
  if (id === false) {
    newIDi = 500 + room.idx2id.length;
  } else {
    newIDi = id;
  }

  // some checks on properties of the node
  if (room.nodes.has(newIDi))
    throw `The id ${newIDi} has already been taken.`;
  if (isNaN(n1Idx) || typeof n1Idx !== 'number')
    throw 'Please select neighbor 1.';
  if (n1Idx >= room.idx2id.length)
    throw `Neighbor 1 (${n1Idx}) does not exist.`;
  if (isNaN(n2Idx) || typeof n2Idx !== 'number')
    throw 'Please select neighbor 2.';
  if (n2Idx >= room.idx2id.length)
    throw `Neighbor 2 (${n2Idx}) does not exist.`;
  n1ID = room.idx2id[n1Idx];
  n2ID = room.idx2id[n2Idx];
  if (room.nodes.get(n1ID).degree >= MAX_DEGREE)
    throw `Neighbor1 ${n1ID} already has ${MAX_DEGREE} connections.`;
  if (room.nodes.get(n2ID).degree >= MAX_DEGREE)
    throw `Neighbor2 ${n2ID} already has ${MAX_DEGREE} connections.`;

  // add node, update metadata
  let idx = room.nodes.size;
  room.nodes.set(newIDi, {
    name: name,
    degree: 2,
    idx: idx,
    ip: ip
  });
  room.idx2id.push(newIDi);
  db.query(`INSERT INTO nodes VALUES (${newIDi}, ${room.id}, '${name}', ` +
      `'${ip}')`);
  room.links.push([newIDi,n1ID]);
  db.query(`INSERT INTO links (id_source, id_target) VALUES (${newIDi}, ${n1ID})`);
  room.links.push([newIDi,n2ID]);
  db.query(`INSERT INTO links (id_source, id_target) VALUES (${newIDi}, ${n2ID})`);
  room.nodes.get(n1ID).degree++;
  room.nodes.get(n2ID).degree++;

  return {id: newIDi, idx: idx};
}

function _getdata(req, url, res) {
  res.setHeader('Content-Type', 'application/json');
  const ip = getIP(req);
  const data = url.searchParams;
  const id = (data.has('id') && typeof data.get('id') === 'string' &&
              data.get('id') !== 'NaN' ? parseInt(data.get('id'), 10) : false);
  const roomPath = data.get('room', false);

  try {
    return res.end(JSON.stringify(_getdata_internal(ip, id, roomPath)));
  } catch (errorMessage) {
    return res.writeHead(400, {
      message: errorMessage,
      errorfield: false
    }).end();
  }
}
function _getdata_internal(ip, id = false, roomPath = false) {
  if (!rooms.has(roomPath)) {
    throw 'Room not found.';
  }
  const room = rooms.get(roomPath);

  var returnNodes = [];
  room.nodes.forEach((n, nodeId) => {
    let newNode = {
      id: n.idx,
      name: n.name
    };
    if ((id === false && n.ip === ip) || (id !== false && id === nodeId)) {
      newNode.yours = true;
    }
    returnNodes.push(newNode);
  });
  var returnData = {
      nodes: returnNodes,
      links: room.links.map((link) => {
        return {
          source: room.nodes.get(link[0]).idx,
          target: room.nodes.get(link[1]).idx
        }
      })
  };
  if (room.percolationDone) {
    returnData.percolation = room.percolationResult;
  }
  return returnData;
}

function _rooms(req, url, res) {
  res.setHeader('Content-Type', 'application/json');
  var roomsResult = [];
  rooms.forEach((room) => {
    roomsResult.push({
      id: room.id,
      path: room.path,
      name: room.name,
      numNodes: room.nodes.size
    });
  });
  res.end(JSON.stringify(roomsResult));
}

function _updatedata(req, url, res) {
  const data = url.searchParams;
  if (!data.has('n')) {
    return res.writeHead(400, {message: "Missing parameter n."}).end()
  }
  return res.end(JSON.stringify({
    neighbors: Array.from(nodes).slice(data.get('n')).map((nodeInfo) => {
      var [id, node] = nodeInfo,
          neighbors = [];
      for (let link of links) {
        if (link[0] === id) {
          neighbors.push(nodes.get(link[1]).idx);
          if (neighbors.length === 2) {
            break;
          }
        }
      }
      return {
        id: nodes.get(id).idx,
        name: node.name,
        neighbor1: neighbors[0],
        neighbor2: neighbors[1]
      }
    })
  }));
}

function _percolate(res, room) {
  room.percolationDone = false;
  const node2component = new Map();
  // Assign each node to a component consisting only of itself
  for (const id of room.nodes.keys()) {
    node2component.set(id, {
      members: [id]
    });
  }
  // (Randomly) decide which links remain and merge connected components of remaining links
  const remainingLinks = _.sample(room.links,
                                  Math.ceil(room.links.length * SURVIVAL_P));
  let outputLinks = [];
  remainingLinks.forEach(function (link) {
    const [i, j] = link;
    // Merge connected components when necessary.
    if (node2component.get(i) != node2component.get(j)) {
      node2component.get(j).members.forEach(function(m) {
        node2component.set(m,node2component.get(i));
        node2component.get(i).members.push(m);
      });
    }
    outputLinks.push([room.nodes.get(i).idx, room.nodes.get(j).idx]);
  });
  // Find the size of the largest component
  let largestComponentSize = 0;
  for (const id of room.nodes.keys()) {
    if (node2component.get(id).members.length > largestComponentSize) {
      largestComponentSize = node2component.get(id).members.length;
    }
  }
  // We need to find the winners separately in case their are multiple components of equal size.
  let winners = [];
  for (const id of room.nodes.keys()) {
    if (node2component.get(id).members.length == largestComponentSize) {
      winners.push(room.nodes.get(id).idx);
    }
  }

  room.percolationResult = {
    "winners": winners,
    "remainingLinks": outputLinks
  };

  if (typeof res === 'boolean') {
    return room.percolationResult;
  }
  return res.end(JSON.stringify(room.percolationResult));
}

function _restart(room) {
  db.query(`DELETE FROM links WHERE NOT EXISTS (SELECT 1 FROM nodes
              WHERE nodes.room = ${room.id} AND (nodes.id = links.id_source OR
              nodes.id = links.id_target));
            DELETE FROM nodes WHERE room = ${room.id};`);
  room.nodes.clear();
  room.idx2id.length = 0;
  room.links.length = 0;
  room.percolationDone = false;
  room.percolationResult = null;
  db.query(`INSERT INTO nodes (room, name) VALUES (${room.id}, 'Dummy A'),
              (${room.id}, 'Dummy B')`);
  // TODO: find IDs of inserted nodes
  //db.query('INSERT INTO links VALUES (1, 2)');
  initRoomFromDB(room);
}


function close(server) {
  server.destroy();
}

function emitAll(connections) {
  const emitArgs = Array.from(arguments).slice(1);
  for (let key in connections) {
    connections[key].socket.emit.apply(connections[key].socket, emitArgs);
  }
}

function getIP(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',').pop().trim() ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           req.connection.socket.remoteAddress);
}

function getNodesArray() {
  return Array.from(nodes).map((nodeInfo,idx) => {
    return {
      id: nodeInfo[0],
      idx: idx,
      name: nodeInfo[1].name
    }
  });
}

function initFromDB() {
  rooms.clear();
  db.query('SELECT * FROM rooms', function(roomResults) {
    roomResults.forEach((roomRow) => {
      // store room in memory
      rooms.set(roomRow.path, {
        // metadata
        id: roomRow.id,
        name: roomRow.name,
        path: roomRow.path,
        secret: roomRow.secret,
        // network data
        nodes: new Map(),
        idx2id: [],
        links: [],
        // percolation data
        percolationDone: false,
        percolationResult: null
      });
      initRoomFromDB(rooms.get(roomRow.path));
    });
  }, [
    {id: 1, name: 'Dummy Room', path: 'abcdefgh', secret: 'secret'}
  ]);
}

function initRoomFromDB(room) {
  db.query(`SELECT * FROM nodes WHERE room = ${room.id}`, function(nodeResults) {
    // find nodes in this room and store in memory
    nodeResults.forEach((nodeRow, idx) => {
      room.nodes.set(nodeRow.id, {
        name: nodeRow.name,
        degree: 0,
        idx: idx,
        ip: nodeRow.ip_address
      });
      room.idx2id.push(nodeRow.id);
    });

    // add links to the room
    db.query('SELECT `id_source`, `id_target` FROM `links` ' +
        'LEFT JOIN `nodes` ON `links`.`id_source` = `nodes`.`id` WHERE ' +
        '`nodes`.`room` = ' + room.id, function(linkResults) {
      linkResults.forEach((linkRow) => {
        room.links.push([linkRow.id_source, linkRow.id_target]);
        room.nodes.get(linkRow.id_source).degree++;
        room.nodes.get(linkRow.id_target).degree++;
      });
    }, [
      {id_source: 1, id_target: 2}
    ]);
  }, [
    {id: 1, name: 'Dummy A', ip_address: null},
    {id: 2, name: 'Dummy B', ip_address: null}
  ]);
}

function open(server) {
  // open database
  if (STANDALONE) {
    db.setMock(true);
  }
  db.open(initFromDB);


  // initialize socket.io; closing logic from
  // https://github.com/socketio/socket.io/issues/1602#issuecomment-120561951
  const io = require('socket.io')(server, {path: '/percolation-game/socket.io'});
  const connections = {};

  io.on('connection', socket => {
    const ip = socket.handshake.headers['x-real-ip'] ||
                socket.handshake.headers['!~passenger-client-address'] ||
                socket.conn.remoteAddress;
    const userID = (socket.handshake.query.hasOwnProperty('userID') &&
        socket.handshake.query.userID !== 'NaN' ?
        parseInt(socket.handshake.query.userID, 10) : false);
    const key = socket.conn.id;
    connections[key] = {socket, userID};
    socket.conn.on('close', () => delete connections[key]);

    socket.on('add-node', (data) => {
      if (typeof data !== 'object') {
        socket.emit('oops', 'Invalid event data for add-node.');
        return;
      }
      for (let param of ['name', 'neighbors']) {
        if (!data.hasOwnProperty(param)) {
          socket.emit('oops', 'Invalid event data for add-node.');
          return;
        }
      }
      if (!data.hasOwnProperty('id') || typeof data.id !== 'number') {
        data.id = false;
      }
      try {
        var node = _addnode_internal(ip, data.name, data.neighbors[0],
                                    data.neighbors[1], data.id, data.room);
      } catch (errorMessage) {
        socket.emit('oops', errorMessage);
        return;
      }
      emitAll(connections, 'node-added', {
        id: node.idx,
        name: data.name,
        neighbor1: data.neighbors[0],
        neighbor2: data.neighbors[1]
      });
    });

    socket.on('percolate', (roomPath) => {
        if (rooms.has(roomPath)) {
          emitAll(connections, 'percolate-start',
                  _percolate(true, rooms.get(roomPath)));
        }
    });

    socket.on('percolate-done', (roomPath) => {
        if (rooms.has(roomPath)) {
          const room = rooms.get(roomPath);
          room.percolationDone = true;
          emitAll(connections, 'percolate-done', room.percolationResult);
        }
    });

    socket.on('restart', (roomPath) => {
      if (rooms.has(roomPath)) {
        const room = rooms.get(roomPath);
        _restart(room);
        setTimeout(() => {
          for (let key in connections) {
            connections[key].socket.emit('restart', _getdata_internal(ip,
              connections[key].userID, roomPath));
          }
        }, 250);
      }
    });
  });

  server.destroy = () => {
    db.close();
    for (let key in connections) {
      connections[key].socket.disconnect(true);
    }
    server.close();
  }
}

function route(req, res) {
  // determine the requested path, redirect to URL prefix if needed
  const url = new URL(req.url, `http://${req.headers.host}`);
  const reqPath = url.pathname.split('/');
  const prefixPath = URL_PREFIX.split('/');
  const splicedPath = reqPath.splice(0, prefixPath.length); // remove prefix
  if (!_.isEqual(splicedPath, prefixPath)) {
    res.writeHead(307, {'Location': prefixPath.concat(reqPath).join('/')});
    return res.end();
  }

  // handle post submissions
  if (req.method === 'POST') {
    formBody(req, res, (err, body) => {
      if (err || reqPath[0] !== 'r') {
        res.statusCode = 500;
        return res.end('Internal server error.');
      }

      if (Object.keys(body).indexOf('secret') < 0 || !rooms.has(reqPath[1]) ||
          rooms.get(reqPath[1]).secret !== body.secret) {
        res.writeHead(303, {'Location': `${URL_PREFIX}?error=invalid_secret`});
        return res.end();
      }

      routeAdmin(reqPath, res);
    });
    return;
  }

  // serve files in the public directory
  if (reqPath.length > 1 && fs.existsSync(
        path.resolve(__dirname, 'public', reqPath.join('/')))) {
    serveHtml(res, ['public'].concat(reqPath).join('/'));
    return;
  }

  // route request
  switch (reqPath[0]) {
    case 'addnode':
      return _addnode(req, url, res);
    case 'getdata':
      return _getdata(req, url, res);
    case 'r':
      serveHtml(res, 'views/interface.ejs');
      break;
    case 'rooms':
      return _rooms(req, url, res);
    case 'updatedata':
      return _updatedata(req, url, res);
    default:
      serveHtml(res, 'views/index.ejs', {search: url.searchParams});
  }
}

function routeAdmin(reqPath, res) {
  const room = rooms.get(reqPath[1]);
  switch (reqPath[1]) {
    case 'finishPercolation':
      room.percolationDone = true;
      return res.end('okay');
    case 'percolate':
      return _percolate(res, room);
    case 'restart':
      _restart(room);
      setTimeout(() => res.end('okay'), 250);
      return;
    case 'undoPercolation':
      room.percolationDone = false;
      room.percolationResult = null;
      return res.end('okay');
    default:
      serveHtml(res, 'views/admin.ejs');
  }
}

function serveHtml(res, filename, vars = {}) {
  vars['URL_PREFIX'] = URL_PREFIX;
  fs.readFile(path.resolve(__dirname, filename), 'utf-8', function(err, data) {
    var contentType = mime.lookup(filename) || 'application/octet-stream',
        dynamic = false;
    if (filename.endsWith('ejs')) {
      contentType = mime.lookup('html');
      dynamic = true;
    }
    res.writeHead(200, {
      'Content-Type': contentType
    });
    res.write(dynamic ? ejs.render(data, vars) : data);
    res.end();
  });
}


// --- exports and entry point -------------------------------------------------
module.exports = {
  'close': close,
  'open': open,
  'route': route
};

if (IS_PASSENGER || (STANDALONE && require.main === module)) {
  let port = process.env.PORT;
  if (IS_PASSENGER) {
    port = 'passenger';
  }
  let server = http.createServer(route);
  open(server);
  process.on('SIGINT', function() {
    close(server);
  });
  server.listen(port);
  logger.info(`running; listening on port ${port}`);
}
