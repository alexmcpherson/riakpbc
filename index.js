var Stream = require('stream');
var Protobuf = require('protobuf.js');
var riakproto = require('riakproto');
var _merge = require('./lib/merge');
var quorum = require('./lib/quorum');
var parseResponse = require('./lib/parse-response');
var ConnectionManager = require('./lib/connection-manager');

function RiakPBC(options) {
    options = options || {};
    options.host = options.host || '127.0.0.1';
    options.port = options.port || 8087;
    options.timeout = options.timeout || 1000;
    options.auto_connect = options.hasOwnProperty('auto_connect') ? options.auto_connect : true;

    this.connection = new ConnectionManager(options);
    this.connection.receive = this._processMessage.bind(this);

    this.translator = new Protobuf(riakproto);

    this.queue = [];
    this.reply = {};
}

RiakPBC.prototype._processMessage = function (data) {
    var response, messageCode, err, done;

    messageCode = riakproto.codes['' + data[0]];
    response = this.translator.decode(messageCode, data.slice(1));

    if (!response) {
        if (this.task.callback) {
            this.task.callback(new Error('Failed to decode response message'));
        } else {
            this.task.stream.emit('error', new Error('Failed to decode response message'));
        }
        this._cleanup();
        return;
    }

    response = parseResponse(response);

    if (response.errmsg) {
        err = new Error(response.errmsg);
        err.code = response.errcode;

        if (this.task.callback) {
            this.task.callback(err);
        } else {
            this.task.stream.emit('error', err);
        }

        this._cleanup();
        return;
    }

    if (response.done) {
        done = true;
        delete response.done;
    }

    if (this.task.callback) {
        this.reply = _merge(this.reply, response);
    } else if (Object.keys(response).length) {
        this.task.stream.write(response);
    }

    if (done || !this.task.expectMultiple || messageCode === 'RpbErrorResp') {
        if (this.task.callback) {
            this.task.callback(undefined, this.reply);
        } else {
            this.task.stream.end();
        }
        this._cleanup();
    }
};

RiakPBC.prototype._cleanup = function () {
    this.task = undefined;
    this.reply = {};
    this._processNext();
};

RiakPBC.prototype._processNext = function () {
    if (!this.queue.length || this.task) {
        return;
    }

    this.task = this.queue.shift();

    this.connection.send(this.task.message, function (err) {
        if (err) {
            if (this.task.callback) {
                this.task.callback(err);
            } else {
                this.task.stream.emit('error', err);
            }
        }
    }.bind(this));
};

// RiakPBC.prototype.makeRequest = function (type, data, callback, expectMultiple, streaming) {
RiakPBC.prototype.makeRequest = function (opts) {
    var buffer, message, stream = null;

    if (riakproto.messages[opts.type]) {
        buffer = this.translator.encode(opts.type, opts.params);
    } else {
        buffer = new Buffer(0);
    }

    message = new Buffer(buffer.length + 5);

    if (typeof opts.callback !== 'function') {
        stream = writableStream();
    }

    message.writeInt32BE(buffer.length + 1, 0);
    message.writeInt8(riakproto.codes[opts.type], 4);
    buffer.copy(message, 5);

    this.queue.push({
        message: message,
        callback: typeof opts.callback === 'function' ? opts.callback : null,
        expectMultiple: opts.expectMultiple,
        stream: stream
    });

    this._processNext();

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
    if (params.props) {
        params.props = quorum.convert(params.props);
    }

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

RiakPBC.prototype.getKeys = function (params, callback) {
    return this.makeRequest({
        type: 'RpbListKeysReq',
        params: params,
        expectMultiple: true,
        callback: callback
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

RiakPBC.prototype.mapred = function (params, callback) {
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

        callback(undefined, rows);
    }

    return parseMapReduceStream(this.makeRequest({
        type: 'RpbMapRedReq',
        params: params,
        callback: callback ? cb : undefined,
        expectMultiple: true
    }));
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

RiakPBC.prototype.getIndex = function (params, callback) {
    params.stream = true;

    return this.makeRequest({
        type: 'RpbIndexReq',
        params: params,
        expectMultiple: true,
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

RiakPBC.prototype.setBucketType = function (params, callback) {
    return this.makeRequest({
        type: 'RpbSetBucketTypeReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.getBucketType = function (params, callback) {
    return this.makeRequest({
        type: 'RpbGetBucketTypeReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.updateDtype = function (params, callback) {
    return this.makeRequest({
        type: 'DtUpdateReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.fetchDtype = function (params, callback) {
    return this.makeRequest({
        type: 'DtFetchReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.ykGetIndex = function (params, callback) {
    return this.makeRequest({
        type: 'RpbYokozunaIndexGetReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.ykPutIndex = function (params, callback) {
    return this.makeRequest({
        type: 'RpbYokozunaIndexPutReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.ykDeleteIndex = function (params, callback) {
    return this.makeRequest({
        type: 'RpbYokozunaIndexDeleteReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.ykPutSchema = function (params, callback) {
    return this.makeRequest({
        type: 'RpbYokozunaSchemaPutReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.ykGetSchema = function (params, callback) {
    return this.makeRequest({
        type: 'RpbYokozunaSchemaGetReq',
        params: params,
        callback: callback
    });
};

RiakPBC.prototype.connect = function (callback) {
    this.connection.connect(callback);
};

RiakPBC.prototype.disconnect = function () {
    if (this.task) {
        this.queue.unshift(this.task);
        this.task = undefined;
    }

    this.connection.disconnect();
};

exports.createClient = function (options) {
    return new RiakPBC(options);
};

function writableStream() {
    return new Stream.PassThrough({ objectMode: true });
}

function parseMapReduceStream(rawStream) {
    if (!rawStream) {
        return null;
    }

    var liner = new Stream.Transform({ objectMode: true });

    liner._transform = function (chunk, encoding, done) {
        var response = chunk.response;
        var json = JSON.parse(response);

        json.forEach(function (row) {
            this.push(row);
        }.bind(this));

        done();
    };

    rawStream.on('error', function (err) {
        liner.emit('error', err);
    });

    rawStream.pipe(liner);
    return liner;
}
