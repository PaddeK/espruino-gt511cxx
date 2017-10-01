'use strict';

let GT511CXX, Protocol,
    Devices = {
        GT511C11: {},
        GT511C1R: {},
        GT511C31: {},
        GT511C3: {},
        GT511C51: {},
        GT511C5: {}
    };

function sendCmdReceiveDataHelper (gt511cxx, dataSize, cmd, cmdParam, callback) {
    return new Promise((resolve, reject) => {
        let errorHandler = err => !clearTimeout() && reject(err),
            timeout = setTimeout(() => reject('timeout exceeded'), Protocol.C.TIMEOUT.RECEIVE_DATA);

        Protocol.C.LENGTH.DATA = dataSize;

        gt511cxx.protocol.removeAllListeners('dataPacket');
        gt511cxx.protocol.on('dataPacket', response => !clearTimeout(timeout) && resolve(callback(response)));
        gt511cxx.protocol.sendCmd(cmd, cmdParam).then(() => {}, errorHandler).catch(errorHandler);
    });
}

function sendCmdDataHelper (gt511cxx, cmd, prm, data) {
    let sd = gt511cxx.protocol.sendData.bind(gt511cxx.protocol, data),
        sc = gt511cxx.protocol.sendCmd.bind(gt511cxx.protocol, cmd, prm);

    return new Promise((resolve, reject) => sc().then(() => sd().then(resolve, e => reject(e)), e => reject(e)));
}

function sendBytes (gt511cxx, bytes, resolve, reject) {
    gt511cxx.removeAllListeners('responsePacket');
    gt511cxx.on('responsePacket', res => [reject, resolve][~~res.ack](res.prm));
    gt511cxx.serial.write(bytes);
}

function completeDeviceData(device) {
    let info = {FirmwareVersion: undefined, IsoAreaMaxSize: undefined, Serialnumber: undefined},
        key = Object.keys(Devices).filter(key => Devices[key] === device).pop(),
        data = [{X: 240, Y: 216, T: 506}, {X: 258, Y: 202, RX: 160, RY: 120, T: 498}];

    if (key) {
        key = ~~key[6] >> 1;
        device.Info = info;
        device.MAX_FINGERPRINTS = 20 * Math.pow(10, key);
        device.IMAGE_SIZE_X = data[~~!!key].X;
        device.IMAGE_SIZE_Y = data[~~!!key].Y;
        device.IMAGE_BYTES = device.IMAGE_SIZE_X * device.IMAGE_SIZE_Y;
        device.RAW_IMAGE_SIZE_X = data[~~!!key].RX || device.IMAGE_SIZE_X;
        device.RAW_IMAGE_SIZE_Y = data[~~!!key].RY || device.IMAGE_SIZE_Y;
        device.RAW_IMAGE_BYTES = device.RAW_IMAGE_SIZE_X * device.RAW_IMAGE_SIZE_Y;
        device.TEMPLATE_SIZE = data[~~!!key].T;
    }

    return device;
}

Protocol = function(serial) {
    this.serial = serial;
    this.resetData();
};

Protocol.C = {
    START_CODE: {
        COMMAND_1: 0x55,
        COMMAND_2: 0xAA,
        RESPONSE_1: 0x55,
        RESPONSE_2: 0xAA,
        DATA_1: 0x5A,
        DATA_2: 0xA5
    },
    TIMEOUT: {
        SEND_CMD: 1000,
        SEND_DATA: 1000,
        RECEIVE_DATA: 5000
    },
    PACKET: {
        RESPONSE: E.toString([0x55, 0xAA]),
        DATA: E.toString([0x5A, 0xA5])
    },
    LENGTH: {
        RESPONSE: 12,
        DATA: -1 // dynamic
    },
    COMMAND: {
        OPEN: 0x01,
        CLOSE: 0x02,
        CHANGE_BAUDRATE: 0x04,
        LED: 0x12,
        ENROLL_COUNT: 0x20,
        CHECK_ENROLLED: 0x21,
        ENROLL_START: 0x22,
        ENROLL_1: 0x23,
        ENROLL_2: 0x24,
        ENROLL_3: 0x25,
        IS_PRESS_FINGER: 0x26,
        DELETE_ID: 0x40,
        DELETE_ALL: 0x41,
        VERIFY: 0x50,
        IDENTIFY: 0x51,
        VERIFY_TEMPLATE: 0x52,
        IDENTIFY_TEMPLATE: 0x53,
        CAPTURE_FINGER: 0x60,
        MAKE_TEMPLATE: 0x61,
        GET_TEMPLATE: 0x70,
        SET_TEMPLATE: 0x71
    },
    ERROR: {
        NACK_INVALID_POS: 0x1003,
        NACK_IS_NOT_USED: 0x1004,
        NACK_IS_ALREADY_USED: 0x1005,
        NACK_COMM_ERR: 0x1006,
        NACK_VERIFY_FAILED: 0x1007,
        NACK_IDENTIFY_FAILED: 0x1008,
        NACK_DB_IS_FULL: 0x1009,
        NACK_DB_IS_EMPTY: 0x100A,
        NACK_BAD_FINGER: 0x100C,
        NACK_ENROLL_FAILED: 0x100D,
        NACK_IS_NOT_SUPPORTED: 0x100E,
        NACK_DEV_ERR: 0x100F,
        NACK_INVALID_PARAM: 0x1011,
        NACK_FINGER_IS_NOT_PRESSED: 0x1012
    },
    DEVICE_ID: 0x0001,
    ACK: 0x0030,
    NACK: 0x0031
};

Protocol.prototype.parser = function(data) {
    this.buffer += data;

    this.handlePacket(Protocol.C.PACKET.RESPONSE, Protocol.C.LENGTH.RESPONSE, packet => {
        let res = new Uint16Array(packet, 0, Protocol.C.LENGTH.RESPONSE >> 1);
        this.emit('responsePacket', {
            prm: res[2],
            ack: res[4] === Protocol.C.ACK,
            crc: this.validChecksum(packet, res[5])
        });
    });

    this.handlePacket(Protocol.C.PACKET.DATA, Protocol.C.LENGTH.DATA, packet => {
        this.emit('dataPacket', {
            dta: new Uint8Array(packet, 4, packet.length - 6),
            crc: this.validChecksum(packet, new Uint16Array(packet, packet.length - 2, 1)[0])
        });
    });
};
Protocol.prototype.handlePacket = function (header, length, cb) {
    if (this.buffer.length >= length && this.buffer.charAt(0) === header[0] && this.buffer.charAt(1) === header[1]) {
        let packet = E.toArrayBuffer(this.buffer.substring(0, length));
        this.buffer = this.buffer.substring(length);
        cb.call(this, packet);
    }
};
Protocol.prototype.validChecksum = function(data, crc) {
    return E.sum(new Uint8Array(data, 0, data.length - 2)) === crc ? true : this.resetData();
};
Protocol.prototype.resetData = function () {
    this.buffer = '';
    Protocol.C.LENGTH.DATA = -1;
    return false;
};
Protocol.prototype.sendCmd = function(cmd, param) {
    let crc, buffer, me = this;

    return new Promise((resolve, reject) => {
        param = new Uint8Array((new Uint32Array([param | 0])).buffer, 0, 4);

        buffer = new Uint8Array(Protocol.C.LENGTH.RESPONSE);
        buffer.set([
            Protocol.C.START_CODE.COMMAND_1, Protocol.C.START_CODE.COMMAND_2,
            Protocol.C.DEVICE_ID & 0x00FF, (Protocol.C.DEVICE_ID >> 8) & 0x00FF,
            param[0], param[1], param[2], param[3], cmd & 0x00FF, (cmd >> 8) & 0x00FF,
        ]);
        crc = E.sum(buffer);
        buffer.set([crc & 0x00FF, (crc >> 8) & 0x00FF], 10);

        sendBytes(me, buffer, resolve, reject);
    });
};
Protocol.prototype.sendData = function(data) {
    let crc, buffer, me = this;

    return new Promise((resolve, reject) => {
        if (data instanceof Uint8Array) {
            buffer = new Uint8Array(data.length + 6);
            buffer.set([
                Protocol.C.START_CODE.DATA_1, Protocol.C.START_CODE.DATA_2,
                Protocol.C.DEVICE_ID & 0x00FF, (Protocol.C.DEVICE_ID >> 8) & 0x00FF
            ]);
            buffer.set(data, 4);
            crc = E.sum(buffer);
            buffer.set([crc & 0x00FF, (crc >> 8) & 0x00FF], buffer.length - 2);

            return sendBytes(me, buffer, resolve, reject);
        }

        return reject('invalid data type');
    });
};

GT511CXX = function (device, serial) {
    this.device = completeDeviceData(device);
    this.serial = serial;

    this.protocol = new Protocol(this.serial);

    serial.removeAllListeners('data');
    serial.on('data', this.protocol.parser.bind(this.protocol));
};

GT511CXX.Devices = Devices;

GT511CXX.prototype.close = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.CLOSE);
};
GT511CXX.prototype.switchLED = function(on) {
    return this.protocol.sendCmd(Protocol.C.COMMAND.LED, ~~!!on);
};
GT511CXX.prototype.deleteId = function(id) {
    return this.protocol.sendCmd(Protocol.C.COMMAND.DELETE_ID, id);
};
GT511CXX.prototype.deleteAll = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.DELETE_ALL);
};
GT511CXX.prototype.verify = function(id) {
    return this.protocol.sendCmd(Protocol.C.COMMAND.VERIFY, id);
};
GT511CXX.prototype.identify = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.IDENTIFY);
};
GT511CXX.prototype.captureFinger = function(best) {
    return this.protocol.sendCmd(Protocol.C.COMMAND.CAPTURE_FINGER, ~~!!best);
};
GT511CXX.prototype.getEnrollCount = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.ENROLL_COUNT);
};
GT511CXX.prototype.checkEnrolled = function(id) {
    return this.protocol.sendCmd(Protocol.C.CHECK_ENROLLED, id);
};
GT511CXX.prototype.enrollStart = function(id) {
    return this.protocol.sendCmd(Protocol.C.COMMAND.ENROLL_START, id);
};
GT511CXX.prototype.enroll1 = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.ENROLL_1);
};
GT511CXX.prototype.enroll2 = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.ENROLL_2);
};
GT511CXX.prototype.enroll3 = function() {
    return this.protocol.sendCmd(Protocol.C.COMMAND.ENROLL_3);
};
GT511CXX.prototype.verifyTemplate = function(id, tpl) {
    return sendCmdDataHelper(this, Protocol.C.COMMAND.VERIFY_TEMPLATE, id, tpl);
};
GT511CXX.prototype.identifyTemplate = function(tpl) {
    return sendCmdDataHelper(this, Protocol.C.COMMAND.IDENTIFY_TEMPLATE, undefined, tpl);
};
GT511CXX.prototype.setTemplate = function(id, tpl) {
    return sendCmdDataHelper(this, Protocol.C.COMMAND.SET_TEMPLATE, id, tpl);
};
GT511CXX.prototype.setBaudrate = function(baud) {
    let me = this,
        cmd = Protocol.C.COMMAND.CHANGE_BAUDRATE;

    return new Promise((res, rej) => {
        if (baud === me.serial._baudrate) {
            return rej('baudrate already set to ' + baud);
        }

        if ([9600, 19200, 38400, 57600, 115200].indexOf(baud) === -1) {
            return rej('baudrate invalid');
        }

        me.protocol.sendCmd(cmd, baud).then(() => me.serial.setup(baud, me.serial._options) && res(), rej).catch(rej);
    });
};
GT511CXX.prototype.isPressFinger = function() {
    let me = this,
        msg = 'finger is not pressed',
        cmd = Protocol.C.COMMAND.IS_PRESS_FINGER;

    return new Promise((res, rej) => me.protocol.sendCmd(cmd).then(p => !p && res() || p && rej(msg), rej).catch(rej));
};
GT511CXX.prototype.waitFinger = function(ms, release, delay) {
    let param, timeout, interval, me = this;

    release = !!release;
    delay = ~~delay || 1000;

    return new Promise((resolve, reject) => {
        timeout = setTimeout(() => !clearInterval(interval) && reject('wait timeout exceeded'), ms);
        param = [() => !clearTimeout(timeout) && !clearInterval(interval) && resolve(), () => {}];
        interval = setInterval(() => me.isPressFinger().then(param[~~release]).catch(param[~~!release]), delay);
    });
};
GT511CXX.prototype.makeTemplate = function() {
    let size = this.device.TEMPLATE_SIZE + 6,
        cmd = Protocol.C.COMMAND.MAKE_TEMPLATE;

    return sendCmdReceiveDataHelper(this, size, cmd, undefined, (response) => response.dta);
};
GT511CXX.prototype.getTemplate = function(id) {
    let size = this.device.TEMPLATE_SIZE + 6,
        cmd = Protocol.C.COMMAND.GET_TEMPLATE;

    return sendCmdReceiveDataHelper(this, size, cmd, id, (response) => response.dta);
};
GT511CXX.prototype.open = function(extraInfo) {
    extraInfo = !!extraInfo;

    if (extraInfo) {
        let me = this;

        return sendCmdReceiveDataHelper(me, 30, Protocol.C.COMMAND.OPEN, 1, response => {
            if (response.crc) {
                let data = new Uint8Array(response.dta);

                me.device.Info.FirmwareVersion = (new Uint32Array(data.buffer, 0, 1))[0].toString(16);
                me.device.Info.IsoAreaMaxSize = (new Uint32Array(data.buffer, 4, 1))[0].toString(16);
                me.device.Info.Serialnumber = data.slice(8).reduce((p, c) => p + ('0' + c.toString(16)).slice(-2), '');
            }

            return me.device.Info;
        });
    }

    return this.protocol.sendCmd(Protocol.C.COMMAND.OPEN);
};
GT511CXX.prototype.enroll = function(id) {
    let open = () => this.open(),
        start = () => this.enrollStart(id),
        capture = () => this.captureFinger(true),
        waitFinger = () => this.waitFinger(10000, false),
        waitReleaseFinger = () => this.waitFinger(10000, true),
        led = (b) => () => this.switchLED(!!b),
        enroll1 = () => this.enroll1(),
        enroll2 = () => this.enroll2(),
        enroll3 = () => this.enroll3(),
        log = (s) => () => Promise.resolve(console.log(s)),
        enrollDelay = () => new Promise(resolve => setTimeout(resolve, 500)),
        blinkDelay = () => new Promise(resolve => setTimeout(resolve, 100));

    return new Promise((resolve, reject) => {
        GT511CXX.sequence([
            open, led(1),
            log('press finger'), waitFinger, start,
            capture, enroll1, log('enroll 1 done'), led(0), blinkDelay, led(1), log('release finger'), waitReleaseFinger,
            enrollDelay,
            log('press finger'), waitFinger,
            capture, enroll2, log('enroll 2 done'), led(0), blinkDelay, led(1), log('release finger'), waitReleaseFinger,
            enrollDelay,
            log('press finger'), waitFinger,
            capture, enroll3, log('enroll 3 done'), led(0)
        ]).then(resolve).catch(err => led(0)().then(() => reject(err)).catch(reject));
    });
};

GT511CXX.sequence = fs => fs.reduce((prm, fn) => prm.then(res => fn().then(res.concat.bind(res))), Promise.resolve([]));

module.exports = GT511CXX;