var net = require('net');
var Stream = require('stream');
var protobuf = require('protobuf.js');
var butils = require('butils');
var through = require('through');
var path = require('path');
var _merge = require('./lib/merge');
var parseContent = require('./lib/parse-content');

var messageCodes = {
    '0': 'RpbErrorResp',
    '1': 'RpbPingReq',
    '2': 'RpbPingResp',
    '3': 'RpbGetClientIdReq',
    '4': 'RpbGetClientIdResp',
    '5': 'RpbSetClientIdReq',
    '6': 'RpbSetClientIdResp',
    '7': 'RpbGetServerInfoReq',
    '8': 'RpbGetServerInfoResp',
    '9': 'RpbGetReq',
    '10': 'RpbGetResp',
    '11': 'RpbPutReq',
    '12': 'RpbPutResp',
    '13': 'RpbDelReq',
    '14': 'RpbDelResp',
    '15': 'RpbListBucketsReq',
    '16': 'RpbListBucketsResp',
    '17': 'RpbListKeysReq',
    '18': 'RpbListKeysResp',
    '19': 'RpbGetBucketReq',
    '20': 'RpbGetBucketResp',
    '21': 'RpbSetBucketReq',
    '22': 'RpbSetBucketResp',
    '23': 'RpbMapRedReq',
    '24': 'RpbMapRedResp',
    '25': 'RpbIndexReq',
    '26': 'RpbIndexResp',
    '27': 'RpbSearchQueryReq',
    '28': 'RpbSearchQueryResp',
    // 1.4
    '29': 'RpbResetBucketReq',
    '30': 'RpbResetBucketResp',
    '40': 'RpbCSBucketReq',
    '41': 'RpbCSBucketResp',
    '50': 'RpbCounterUpdateReq',
    '51': 'RpbCounterUpdateResp',
    '52': 'RpbCounterGetReq',
    '53': 'RpbCounterGetResp',
};

Object.keys(messageCodes).forEach(function (key) {
    messageCodes[messageCodes[key]] = Number(key);
});

function RiakPBC(options) {
    var self = this;
    options = options || {};
    self.host = options.host || '127.0.0.1';
    self.port = options.port || 8087;
    self.timeout = options.timeout || 1000;
    self.bucket = options.bucket || undefined;
    self.translator = protobuf.loadSchema(path.join(__dirname, './spec/riak_kv.proto'));
    self.client = new net.Socket();
    self.connected = false;
    self.client.on('end', self.disconnect.bind(this));
    self.client.on('error', self.disconnect.bind(this));
    self.client.on('data', self._processPacket.bind(this));
    self.paused = false;
    self.queue = [];
    self.reply = {};
    self.resBuffers = [];
    self.numBytesAwaiting = 0;
}

RiakPBC.prototype._splitPacket = function (pkt) {
    var self = this;
    var pos = 0;
    var len;

    if (self.numBytesAwaiting > 0) {
        len = Math.min(pkt.length, self.numBytesAwaiting);
        var oldBuf = self.resBuffers[self.resBuffers.length - 1];
        var newBuf = new Buffer(oldBuf.length + len);
        oldBuf.copy(newBuf, 0);
        pkt.slice(0, len).copy(newBuf, oldBuf.length);
        self.resBuffers[self.resBuffers.length - 1] = newBuf;
        pos = len;
        self.numBytesAwaiting -= len;
    } else {
        self.resBuffers = [];
    }

    while (pos < pkt.length) {
        len = butils.readInt32(pkt, pos);
        self.numBytesAwaiting = len + 4 - pkt.length;
        self.resBuffers.push(pkt.slice(pos + 4, Math.min(pos + len + 4, pkt.length)));
        pos += len + 4;
    }
};

RiakPBC.prototype._processPacket = function (chunk) {
    var self = this;

    self._splitPacket(chunk);
    if (self.numBytesAwaiting > 0) {
        return;
    }
    self._processAllResBuffers();
};

RiakPBC.prototype._processAllResBuffers = function () {
    var self = this;

    self.resBuffers.forEach(self._processSingleResBuffer.bind(this));

    if (!self.task.expectMultiple || self.reply.done || self.task.mc === 'RpbErrorResp') {
        if (self.task.stream) {
            self.task.stream.end();
        }

        if (self.task.callback) {
            self.task.callback(self.task.err, self.reply);
        }

        self.task = undefined;
        self.reply = {};
        self.paused = false;
        self._processNext();
    }
};

RiakPBC.prototype._processSingleResBuffer = function (packet) {
    var self = this;
    var response;

    self.task.mc = messageCodes['' + packet[0]];
    response = self.translator.decode(self.task.mc, packet.slice(1));
    if (response.content && Array.isArray(response.content)) {
        response.content.forEach(parseContent);
    }

    if (response.errmsg) {
        self.task.err = new Error(response.errmsg);
        self.task.err.code = response.errcode;
        if (self.task.stream) {
            self.task.stream.emit('error', self.task.err);
            return;
        }
    }

    if (self.task.stream && !response.done) {
        self.task.stream.write(response);
    }

    if (self.task.stream) {
        self.reply = response;
    } else {
        self.reply = _merge(self.reply, response);
    }
};

RiakPBC.prototype._processNext = function () {
    var self = this;

    if (self.queue.length && !self.paused) {
        self.paused = true;
        self.connect(function (err) {
            self.task = self.queue.shift();

            if (!self.task) {
                return;
            }

            if (err) {
                if (self.task.callback) {
                    self.task.callback(err);
                    return;
                }
                if (self.task.stream) {
                    self.task.stream.emit('error', err);
                    return;
                }

                // unhandled error, throw it
                throw err;

            }

            self.client.write(self.task.message);
        });
    }
};

// RiakPBC.prototype.makeRequest = function (type, data, callback, expectMultiple, streaming) {
RiakPBC.prototype.makeRequest = function (opts) {
    var self = this;
    var type = opts.type;
    var params = opts.params;
    var streaming = opts.streaming;
    var callback = opts.callback;
    var expectMultiple = opts.expectMultiple;
    var buffer = this.translator.encode(type, params);
    var message = [];
    var stream, queueOpts;

    if (streaming) {
        stream = writableStream();
    }

    butils.writeInt32(message, buffer.length + 1);
    butils.writeInt(message, messageCodes[type], 4);
    message = message.concat(buffer);
    queueOpts = {
        message: new Buffer(message),
        callback: callback,
        expectMultiple: expectMultiple,
        stream: stream
    };
    self.queue.push(queueOpts);
    self._processNext();
    return stream;
};

RiakPBC.prototype.getBuckets = function (callback) {
    return this.makeRequest({
        type: 'RpbListBucketsReq',
        params: null,
        callback: callback
    });
};

RiakPBC.prototype.getBucket = function (params, callback) {
    return this.makeRequest({
        type: 'RpbGetBucketReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.setBucket = function (params, callback) {
    return this.makeRequest({
        type: 'RpbSetBucketReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.resetBucket = function (params, callback) {
    return this.makeRequest({
        type: 'RpbResetBucketReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.getKeys = function (params, streaming, callback) {
    if (typeof streaming === 'function') {
        callback = streaming;
        streaming = false;
    }

    return this.makeRequest({
        type: 'RpbListKeysReq',
        params: params,
        expectMultiple: true,
        callback: callback,
        streaming: streaming
    });
};

RiakPBC.prototype.put = function (params, callback) {
    return this.makeRequest({
        type: 'RpbPutReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.get = function (params, callback) {
    return this.makeRequest({
        type: 'RpbGetReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.del = function (params, callback) {
    return this.makeRequest({
        type: 'RpbDelReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.mapred = function (params, streaming, callback) {
    var stream;

    function cb(err, reply) {
        if (err) {
            return callback(err);
        }

        delete reply.done;
        var phaseKeys = Object.keys(reply);
        var rows = [];
        var phase;

        phaseKeys.forEach(function (key) {
            phase = reply[key];
            phase.forEach(function (row) {
                rows.push(row);
            });
        });

        if (typeof callback === 'function') {
            callback(null, rows);
        }
    }

    if (typeof streaming === 'function') {
        callback = streaming;
        streaming = false;
    }

    stream = this.makeRequest({
        type: 'RpbMapRedReq',
        params: params,
        callback: cb,
        expectMultiple: true,
        streaming: streaming
    });

    return streaming ? parseMapReduceStream(stream) : stream;
};


RiakPBC.prototype.getCounter = function (params, callback) {
    return this.makeRequest({
        type: 'RpbCounterGetReq',
        params: params,
        callback: callback
    });
};


RiakPBC.prototype.updateCounter = function (params, callback) {
    return this.makeRequest({
        type: 'RpbCounterUpdateReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.getIndex = function (params, streaming, callback) {
    var expectMultiple = true;

    if (typeof streaming === 'function') {
        callback = streaming;
        streaming = false;
        expectMultiple = false;
    } else {
        params.stream = true;
    }

    return this.makeRequest({
        type: 'RpbIndexReq',
        params: params,
        streaming: streaming,
        expectMultiple: expectMultiple,
        callback: callback
    });
};

RiakPBC.prototype.search = function (params, callback) {
    return this.makeRequest({
        type: 'RpbSearchQueryReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.getClientId = function (callback) {
    return this.makeRequest({
        type: 'RpbGetClientIdReq',
        params: null,
        callback: callback
    });
};

RiakPBC.prototype.setClientId = function (params, callback) {
    return this.makeRequest({
        type: 'RpbSetClientIdReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.getServerInfo = function (callback) {
    return this.makeRequest({
        type: 'RpbGetServerInfoReq',
        params: null,
        callback: callback
    });
};

RiakPBC.prototype.ping = function (callback) {
    return this.makeRequest({
        type: 'RpbPingReq',
        params: null,
        callback: callback
    });
};

RiakPBC.prototype.connect = function (callback) {
    if (this.connected) {
        return callback(null);
    }

    var self = this;
    var timeoutGuard = setTimeout(function () {
        callback(new Error('Connection timeout'));
    }, self.timeout);

    self.client.connect(self.port, self.host, function () {
        clearTimeout(timeoutGuard);
        self.connected = true;
        callback(null);
    });
};

RiakPBC.prototype.disconnect = function () {
    if (!this.connected) {
        return;
    }

    this.client.end();
    this.connected = false;

    if (this.task) {
        this.queue.unshift(this.task);
        this.task = undefined;
    }
};

exports.createClient = function (options) {
    return new RiakPBC(options);
};

function writableStream() {
    var stream = through(function write(data) {
        this.queue(data);
    });

    return stream;
}
function parseMapReduceStream(rawStream) {
    var liner = new Stream.Transform({
        objectMode: true
    });

    liner._transform = function (chunk, encoding, done) {
        var response = chunk.response;
        var json = JSON.parse(response);
        var self = this;

        json.forEach(function (row) {
            self.push(row);
        });
        done();
    };

    rawStream.on('error', function (err) {
        liner.emit('error', err);
    });

    rawStream.pipe(liner);
    return liner;
}
