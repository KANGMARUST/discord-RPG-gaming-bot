import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const PVP_CATEGORY_NAME = 'PVP';

function createOverwrites(guild, members, voice) {
  const memberAllow = voice
    ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.Stream]
    : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [
    {
      id: guild.roles.everyone.id,
      deny: voice
        ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
        : [PermissionFlagsBits.ViewChannel],
    },
    ...members.map((member) => ({ id: member.id, allow: memberAllow })),
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers,
      ],
    },
  ];
}

class PvpManager {
  constructor() {
    this.sessions = new Map();
    this.userSessions = new Map();
  }

  getByUser(userId) {
    const sessionId = this.userSessions.get(userId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  async start(guild, challenger, opponent) {
    if (this.getByUser(challenger.id) || this.getByUser(opponent.id)) {
      return { ok: false, reason: 'ALREADY_IN_PVP' };
    }
    const required = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers];
    if (!guild.members.me.permissions.has(required)) {
      return { ok: false, reason: 'BOT_MISSING_PERMISSIONS' };
    }

    let category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === PVP_CATEGORY_NAME,
    );
    if (!category) {
      category = await guild.channels.create({
        name: PVP_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        reason: 'PVP 결투 채널 관리',
      });
    }

    const members = [challenger, opponent];
    const voiceChannel = await guild.channels.create({
      name: '콜로세움',
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: createOverwrites(guild, members, true),
      reason: `${challenger.user.tag}님과 ${opponent.user.tag}님의 결투`,
    });
    let textChannel;
    try {
      textChannel = await guild.channels.create({
        name: '채팅-콜로세움',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `${challenger.user.tag} VS ${opponent.user.tag}`,
        permissionOverwrites: createOverwrites(guild, members, false),
        reason: 'PVP 결투 채팅방 생성',
      });
      await Promise.all(
        members.map((member) => member.voice.setChannel(voiceChannel, 'PVP 결투 수락')),
      );
    } catch (error) {
      await Promise.all([
        voiceChannel.delete('PVP 생성 실패').catch(() => {}),
        textChannel?.delete('PVP 생성 실패').catch(() => {}),
      ]);
      throw error;
    }

    const session = {
      id: randomUUID(),
      guildId: guild.id,
      memberIds: members.map((member) => member.id),
      challengerId: challenger.id,
      opponentId: opponent.id,
      categoryId: category.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
    };
    this.sessions.set(session.id, session);
    for (const member of members) this.userSessions.set(member.id, session.id);
    await textChannel.send(
      `# ⚔️ 콜로세움 결투\n<@${challenger.id}> **VS** <@${opponent.id}>\n\n두 결투자만 이 채널과 음성 채널을 이용할 수 있습니다.`,
    );
    return { ok: true, session };
  }

  async end(client, sessionId, reason = 'PVP_ENDED') {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    for (const userId of session.memberIds) this.userSessions.delete(userId);
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) return true;
    await Promise.all([
      guild.channels.cache.get(session.voiceChannelId)?.delete(reason).catch(() => {}),
      guild.channels.cache.get(session.textChannelId)?.delete(reason).catch(() => {}),
    ]);
    await guild.channels.fetch().catch(() => {});
    const category = guild.channels.cache.get(session.categoryId);
    const remaining = guild.channels.cache.filter((channel) => channel.parentId === session.categoryId);
    if (category && remaining.size === 0) await category.delete('진행 중인 PVP 없음').catch(() => {});
    return true;
  }

  async handleVoiceStateUpdate(client, oldState, newState) {
    const session = this.getByUser(oldState.id);
    if (session && oldState.channelId === session.voiceChannelId && newState.channelId !== session.voiceChannelId) {
      await this.end(client, session.id, '결투자가 콜로세움을 떠남');
    }
  }
}

export const pvpManager = new PvpManager();
