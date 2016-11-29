const logger = require('winston')
const crypto = require('crypto')
const ytdl = Promise.promisifyAll(require('ytdl-core'))

const { Module } = require('../../core')

class Music extends Module {
  constructor (...args) {
    super(...args, {
      name: 'music'
    })

    this.connections = new Map()
    this.volume = new Map()
    this.redis = this.bot.engine.cache.client
  }

  init () {
    this.player = this.bot.engine.modules.get('music:player')
    this.queue = this.bot.engine.modules.get('music:queue')
  }

  bindChannel (guildID, textChannelID) {
    this.connections.set(guildID, textChannelID)
  }

  unbindChannel (guildID) {
    this.connections.delete(guildID)
  }

  getBoundChannel (guildID) {
    return this.connections.get(guildID) || null
  }

  getConnection (channel) {
    if (!channel || !channel.guild) return null
    if (this.client.voiceConnections) {
      return this.client.voiceConnections.get(channel.guild.id) || null
    }
    return null
  }

  async connect (voiceID, textChannel) {
    if (!voiceID || !textChannel || !textChannel.guild) {
      return Promise.reject('notChannel')
    }
    const guild = textChannel.guild
    let channel = this.connections.get(guild.id)
    if (channel && channel !== textChannel.id) {
      return Promise.reject('alreadyBinded')
    }
    this.bindChannel(guild.id, textChannel.id)
    if (!this.hasPermissions(guild, this.client.user, 'voiceConnect', 'voiceSpeak')) {
      return Promise.reject('noPerms')
    }
    try {
      return await this.client.joinVoiceChannel(voiceID)
    } catch (err) {
      logger.error(`Could not join voice channel ${voiceID} in ${guild.name} (${guild.id}) - ${err}`)
      return Promise.reject('error')
    }
  }

  getFormatUrl (type, formats) {
    const bestaudio = formats.sort((a, b) => b.audioBitrate - a.audioBitrate)
    .find(f => f.audioBitrate > 0 && !f.bitrate) || formats.find(f => f.audioBitrate > 0)

    if (!bestaudio.url) return
    bestaudio._format = type
    return bestaudio
  }

  getBestAudio (mediaInfo) {
    let formats = mediaInfo.formats.filter(f => [249, 250, 251].includes(parseInt(f.itag)))
    if (formats && formats.length) {
      return this.getFormatUrl('webm', formats)
    }
    formats = mediaInfo.formats.filter(f => [141, 140, 139].includes(parseInt(f.itag)))
    if (!formats || !formats.length) {
      formats = mediaInfo.formats.filter(f => f.container === 'mp4')
    }
    if (formats && formats.length) return this.getFormatUrl('mp4', formats)
  }

  async getInfo (url, fetchAll = false) {
    const key = `music:info:${crypto.createHash('sha256').update(url, 'utf8').digest('hex')}`
    let info = await this.redis.getAsync(key).catch(() => false)
    if (info) return JSON.parse(info)

    try {
      info = await ytdl.getInfoAsync(url)
    } catch (err) {
      return Promise.reject(err)
    }

    if (!info || !info.video_id) return Promise.reject('noVideoFound')
    info.url = `https://www.youtube.com/watch?v=${info.video_id}`

    const bestaudio = this.getBestAudio(info)
    if (bestaudio.url) {
      const match = new RegExp('&expire=([0-9]+)').exec(bestaudio.url)
      if (match && match.length) {
        info.expires = parseInt(match[1]) - 900
      }
    }
    const formattedInfo = {
      video_id: info.video_id,
      title: info.title,
      thumbnail_url: info.thumbnail_url,
      url: info.url,
      audiourl: bestaudio.url,
      audioformat: bestaudio._format,
      audiotype: bestaudio.itag,
      expires: info.expires ? Date.now() - info.expires - 300 : null,
      length: parseInt(info.length_seconds)
    }
    info = fetchAll ? info : formattedInfo
    // this.redis.setex(key, formattedInfo.expires || 21600, JSON.stringify(formattedInfo))
    return info
  }

  async queueSong (guildId, voiceChannel, mediaInfo) {
    if (!this.getPlayingState(voiceChannel)) {
      await this.queue.add(guildId, mediaInfo, true)
      if (mediaInfo.audiourl) {
        try {
          await this.player.play(voiceChannel, mediaInfo)
          return mediaInfo
        } catch (err) {
          return Promise.reject(err)
        }
      }
      try {
        await this.play(voiceChannel)
      } catch (err) {
        return Promise.reject(err)
      }
      return mediaInfo
    }
    await this.queue.add(guildId, mediaInfo)
    return mediaInfo
  }

  getPlayingState (channel) {
    const conn = this.client.voiceConnections.get(channel.guild.id)
    if (!conn) return false
    return conn.playing
  }

  async add (guildId, voiceChannel, url) {
    if (typeof url === 'object') url = url.url
    if (typeof url !== 'string') return Promise.reject('invalidURL')
    url = url.replace('/<|>/g', '')
    let mediaInfo
    try {
      mediaInfo = await this.getInfo(url)
    } catch (err) {
      return Promise.reject(err)
    }
    if (mediaInfo && mediaInfo.length && mediaInfo.length > 5400) {
      return Promise.reject('tooLong')
    }
    return this.queueSong(guildId, voiceChannel, mediaInfo)
  }

  async play (channel, mediaInfo) {
    if (channel.voiceMembers.size === 1 && channel.voiceMembers.has(this.client.user.id)) {
      return this.player.stop(channel, true)
    }
    const guildId = channel.guild.id
    if (!await this.queue.getLength(guildId)) {
      return Promise.reject('noSongs')
    }
    const item = await this.queue.shift(guildId)
    const volume = this.volume.get(guildId) || 2
    if (mediaInfo) {
      return this.player.play(channel, mediaInfo, volume)
    }

    const url = mediaInfo ? mediaInfo.url || item.url : item.url

    try {
      mediaInfo = await this.getInfo(url)
    } catch (err) {
      return Promise.reject(err)
    }
    if (!mediaInfo) {
      this.queue.remove(channel.guild.id)
      return this.play(channel)
    }

    if (this.getPlayingState(channel)) {
      this.player.stop(channel)
    }
    return this.player.play(channel, mediaInfo, volume)
  }

  setVolume (guild, volume) {
    this.volume.set(guild.id, (parseInt(volume, 10) * 2) / 100)
  }

  async skip (msg, force = false) {
    let channel = this.client.getChannel(msg.member.voiceState.channelID)
    if ((await this.queue.getLength(msg.guild.id)) <= 1) return Promise.resolve()

    if (!force && channel.members > 2) {
      let vote = this.votes.get(msg.guild.id) || []
      if (vote.includes(msg.author.id)) {
        return Promise.resolve('alreadyVoted')
      }

      vote.push(msg.author.id)

      if ((vote.length / channel.members) < 0.5) {
        this.votes.set(msg.guild.id, vote)
        return Promise.resolve('voteSuccess')
      } else {
        this.votes.set(msg.guild.id, 0)
      }
    }

    return this.player.skip(msg.guild.id, channel)
  }
}

module.exports = Music