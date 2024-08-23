'use strict';

const EventEmitter = require('events');
const { Buffer } = require('node:buffer');
const { setTimeout } = require('node:timers');
const { IvfJoinner } = require('./video/IvfJoinner');
const Speaking = require('../../../util/Speaking');
const secretbox = require('../util/Secretbox');
const { SILENCE_FRAME } = require('../util/Silence');

// The delay between packets when a user is considered to have stopped speaking
// https://github.com/discordjs/discord.js/issues/3524#issuecomment-540373200
const DISCORD_SPEAKING_DELAY = 250;

class Readable extends require('stream').Readable {
  _read() {} // eslint-disable-line no-empty-function
}

class PacketHandler extends EventEmitter {
  constructor(receiver) {
    super();
    this.nonce = Buffer.alloc(24);
    this.receiver = receiver;
    this.streams = new Map();
    this.videoStreams = new Map();
    this.speakingTimeouts = new Map();
  }

  get connection() {
    return this.receiver.connection;
  }

  _stoppedSpeaking(userId) {
    const streamInfo = this.streams.get(userId);
    if (streamInfo && streamInfo.end === 'silence') {
      this.streams.delete(userId);
      streamInfo.stream.push(null);
    }
  }

  makeStream(user, end) {
    if (this.streams.has(user)) return this.streams.get(user).stream;
    const stream = new Readable();
    stream.on('end', () => this.streams.delete(user));
    this.streams.set(user, { stream, end });
    return stream;
  }

  makeVideoStream(user) {
    if (this.videoStreams.has(user)) return this.videoStreams.get(user);
    const stream = new IvfJoinner('VP8'); // Test VP8 ok
    stream.stream.on('end', () => this.videoStreams.delete(user));
    this.videoStreams.set(user, stream);
    return stream;
  }

  parseBuffer(buffer) {
    const { secret_key, mode } = this.receiver.connection.authentication;

    // Choose correct nonce depending on encryption
    let end;
    if (mode === 'xsalsa20_poly1305_lite') {
      buffer.copy(this.nonce, 0, buffer.length - 4);
      end = buffer.length - 4;
    } else if (mode === 'xsalsa20_poly1305_suffix') {
      buffer.copy(this.nonce, 0, buffer.length - 24);
      end = buffer.length - 24;
    } else {
      buffer.copy(this.nonce, 0, 0, 12);
    }

    // Open packet
    if (!secret_key) return new Error('secret_key cannot be null or undefined');
    let packet = secretbox.methods.open(buffer.slice(12, end), this.nonce, secret_key);
    if (!packet) return new Error('Failed to decrypt voice packet');
    packet = Buffer.from(packet);

    // Strip RTP Header Extensions (one-byte only)
    if (packet[0] === 0xbe && packet[1] === 0xde) {
      const headerExtensionLength = packet.readUInt16BE(2);
      packet = packet.subarray(4 + 4 * headerExtensionLength);
    }

    // Ex VP8
    // <Buffer 90 80 80 00 30 b7 01 9d 01 2a 80 07 38 04 0b c7 08 85 85 88 99 84 88 3f 82 00 06 16 04 f7 06 81 64 9f 6b db 9b 27 38 7b 27 38 7b 27 38 7b 27 38 7b 27 ... 1154 more bytes>
    // 90 80: payloadDescriptorBuf (90 80 if first frame | 80 80 else)
    // 80 00: pictureIdBuf
    // n bytes: chunk raw (Ivf splitter)

    return packet;
  }

  push(buffer) {
    const ssrc = buffer.readUInt32BE(8);
    const userStat = this.connection.ssrcMap.get(ssrc) || this.connection.ssrcMap.get(ssrc - 1); // Maybe vidoe_ssrc ?

    if (!userStat) return;

    let opusPacket;
    const streamInfo = this.streams.get(userStat.userId);
    const videoStreamInfo = this.videoStreams.get(userStat.userId);

    // If the user is in video, we need to check if the packet is just silence
    if (userStat.hasVideo) {
      opusPacket = this.parseBuffer(buffer);
      if (opusPacket instanceof Error) {
        // Only emit an error if we were actively receiving packets from this user
        if (streamInfo || videoStreamInfo) {
          this.emit('error', opusPacket);
        }
        return;
      }
      if (SILENCE_FRAME.equals(opusPacket)) {
        // If this is a silence frame, pretend we never received it
        return;
      }
    }

    let speakingTimeout = this.speakingTimeouts.get(ssrc);
    // Only for voice... idk
    if (this.connection.ssrcMap.has(ssrc)) {
      if (typeof speakingTimeout === 'undefined') {
        // Ensure at least the speaking bit is set.
        // As the object is by reference, it's only needed once per client re-connect.
        if (userStat.speaking === 0) {
          userStat.speaking = Speaking.FLAGS.SPEAKING;
        }
        this.connection.onSpeaking({ user_id: userStat.userId, ssrc: ssrc, speaking: userStat.speaking });
        speakingTimeout = setTimeout(() => {
          try {
            this.connection.onSpeaking({ user_id: userStat.userId, ssrc: ssrc, speaking: 0 });
            clearTimeout(speakingTimeout);
            this.speakingTimeouts.delete(ssrc);
          } catch {
            // Connection already closed, ignore
          }
        }, DISCORD_SPEAKING_DELAY).unref();
        this.speakingTimeouts.set(ssrc, speakingTimeout);
      } else {
        speakingTimeout.refresh();
      }
    }

    if (streamInfo) {
      const { stream } = streamInfo;
      if (!opusPacket) {
        opusPacket = this.parseBuffer(buffer);
        if (opusPacket instanceof Error) {
          this.emit('error', opusPacket);
          return;
        }
      }
      stream.push(opusPacket);
      if (opusPacket === null) {
        // ! null marks EOF for stream
        stream.destroy();
      }
    }

    if (videoStreamInfo) {
      const stream = videoStreamInfo;
      if (!opusPacket) {
        opusPacket = this.parseBuffer(buffer);
        if (opusPacket instanceof Error) {
          this.emit('error', opusPacket);
          return;
        }
      }
      stream.push(opusPacket); // VP8 ? idk
    }
  }
}

module.exports = PacketHandler;
