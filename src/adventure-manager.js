import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { dungeonLogger } from './dungeon-logger.js';

const ADVENTURE_CATEGORY_NAME = '모험중';
export const ENTRANCE_CHANNEL_NAME = '던전입장';
const PLAZA_CATEGORY_NAME = '탑';
const PLAZA_CHANNEL_NAME = '광장';
const STOP_REASONS = new Set(['SOLO_STOP_COMMAND', 'PARTY_STOP_VOTE_PASSED', 'DUNGEON_CLEARED']);

export function roundHealth(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
}

export function createMemberOverwrites(guild, members, type) {
  const everyoneAllow = type === 'voice'
    ? [PermissionFlagsBits.ViewChannel]
    : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const everyoneDeny = type === 'voice'
    ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.Stream]
    : [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.UseApplicationCommands,
      ];
  const memberAllow = type === 'voice'
    ? [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
      ]
    : [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.UseApplicationCommands,
      ];

  return [
    { id: guild.roles.everyone.id, allow: everyoneAllow, deny: everyoneDeny },
    ...members.map((member) => ({ id: member.id, allow: memberAllow })),
    {
      id: guild.members.me.id,
      allow: type === 'voice'
        ? [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
          ]
        : [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageChannels,
          ],
    },
  ];
}

class AdventureManager {
  constructor() {
    this.adventures = new Map();
    this.userAdventures = new Map();
    this.leavePenaltyHandler = null;
  }

  setLeavePenaltyHandler(handler) {
    this.leavePenaltyHandler = handler;
  }

  getByUser(userId) {
    const adventureId = this.userAdventures.get(userId);
    return adventureId ? this.adventures.get(adventureId) : undefined;
  }

  async startParty(guild, leader, members, maxHealthByUser) {
    if (members.some((member) => this.userAdventures.has(member.id))) {
      return { ok: false, reason: 'MEMBER_ALREADY_IN_ADVENTURE' };
    }

    const requiredPermissions = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers];
    if (!guild.members.me.permissions.has(requiredPermissions)) {
      return { ok: false, reason: 'BOT_MISSING_PERMISSIONS' };
    }

    let category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === ADVENTURE_CATEGORY_NAME,
    );
    if (!category) {
      category = await guild.channels.create({
        name: ADVENTURE_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        reason: '던전 모험 채널을 관리하기 위한 카테고리',
      });
    }

    const voiceChannel = await guild.channels.create({
      name: '던전-음성',
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: createMemberOverwrites(guild, members, 'voice'),
      reason: `${leader.user.tag} 공대의 던전 모험 시작`,
    });

    let textChannel;
    try {
      textChannel = await guild.channels.create({
        name: '던전-전투',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `${leader.user.tag} 공대의 던전 전투 채널`,
        permissionOverwrites: createMemberOverwrites(guild, members, 'text'),
        reason: `${leader.user.tag} 공대의 던전 전투 채널 생성`,
      });
    } catch (error) {
      await voiceChannel.delete('텍스트 채널 생성 실패로 모험 취소').catch(() => {});
      throw error;
    }

    const adventure = {
      id: randomUUID(),
      guildId: guild.id,
      leaderId: leader.id,
      memberIds: members.map((member) => member.id),
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      categoryId: category.id,
      floor: 1,
      healthByUser: Object.fromEntries(
        members.map((member) => [member.id, roundHealth(maxHealthByUser[member.id])]),
      ),
      maxHealthByUser: Object.fromEntries(
        members.map((member) => [member.id, roundHealth(maxHealthByUser[member.id])]),
      ),
      startedAt: new Date().toISOString(),
    };

    this.adventures.set(adventure.id, adventure);
    for (const member of members) this.userAdventures.set(member.id, adventure.id);

    try {
      await Promise.all(
        members.map((member) => member.voice.setChannel(voiceChannel, '던전 파티 모험 시작')),
      );
    } catch (error) {
      this.adventures.delete(adventure.id);
      for (const member of members) this.userAdventures.delete(member.id);
      await Promise.all([
        voiceChannel.delete('파티원 이동 실패로 모험 취소').catch(() => {}),
        textChannel.delete('파티원 이동 실패로 모험 취소').catch(() => {}),
      ]);
      throw error;
    }

    const partyList = members
      .map((member) => `${member.id === leader.id ? '👑' : '⚔️'} <@${member.id}>`)
      .join('\n');
    await textChannel
      .send(
        `# 1층 던전 입장\n${partyList}\n\n잠시 후 모험 규칙을 안내하고 탐험을 시작합니다.`,
      )
      .catch((error) => console.error('모험 시작 메시지 전송에 실패했습니다.', error));

    return { ok: true, adventure, voiceChannel, textChannel };
  }

  async end(client, adventureId, reason = 'UNKNOWN') {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) return false;

    await dungeonLogger.finish(adventure.id, reason, {
      floor: adventure.floor,
      remainingMemberIds: [...adventure.memberIds],
      healthByUser: { ...adventure.healthByUser },
    });

    this.adventures.delete(adventureId);
    for (const userId of adventure.memberIds) this.userAdventures.delete(userId);

    const guild = client.guilds.cache.get(adventure.guildId);
    if (!guild) return true;

    if (STOP_REASONS.has(reason)) {
      await this.movePartyToPlaza(guild, adventure);
    }

    const voiceChannel = guild.channels.cache.get(adventure.voiceChannelId);
    const textChannel = guild.channels.cache.get(adventure.textChannelId);
    await Promise.all([
      voiceChannel ? voiceChannel.delete(`모험 종료: ${reason}`).catch(() => {}) : Promise.resolve(),
      textChannel ? textChannel.delete(`모험 종료: ${reason}`).catch(() => {}) : Promise.resolve(),
    ]);

    await guild.channels.fetch().catch(() => {});
    const category = guild.channels.cache.get(adventure.categoryId);
    const remainingChannels = guild.channels.cache.filter(
      (channel) => channel.parentId === adventure.categoryId,
    );
    if (category && remainingChannels.size === 0) {
      await category.delete('진행 중인 모험이 없어 카테고리 정리').catch(() => {});
    }
    return true;
  }

  async movePartyToPlaza(guild, adventure) {
    const plazaCategory = guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildCategory && channel.name === PLAZA_CATEGORY_NAME,
    );
    const plazaChannel = plazaCategory && guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildVoice &&
        channel.name === PLAZA_CHANNEL_NAME &&
        channel.parentId === plazaCategory.id,
    );
    if (!plazaChannel) {
      console.warn('모험 중지 후 이동할 탑/광장 음성 채널을 찾지 못했습니다.');
      return false;
    }

    const members = await Promise.all(
      adventure.memberIds.map((userId) => guild.members.fetch(userId).catch(() => null)),
    );
    await Promise.all(
      members
        .filter((member) => member?.voice.channelId === adventure.voiceChannelId)
        .map((member) =>
          member.voice
            .setChannel(plazaChannel, '모험 중지 후 광장으로 복귀')
            .catch((error) => console.error(`${member.user.tag}님을 광장으로 이동하지 못했습니다.`, error)),
        ),
    );
    return true;
  }

  async endByUser(client, userId, reason) {
    const adventure = this.getByUser(userId);
    return adventure ? this.end(client, adventure.id, reason) : false;
  }

  async removeMember(client, userId, reason = 'PARTY_MEMBER_LEFT') {
    const adventure = this.getByUser(userId);
    if (!adventure) return false;

    const wasLeader = adventure.leaderId === userId;
    const lostEquipment = reason === 'VOICE_CHANNEL_LEFT' && this.leavePenaltyHandler
      ? await this.leavePenaltyHandler(adventure, userId)
      : [];
    await dungeonLogger.append(adventure.id, 'MEMBER_REMOVED', {
      floor: adventure.floor,
      userId,
      reason,
      health: adventure.healthByUser[userId] ?? 0,
      wasLeader,
      lostEquipment: lostEquipment.map((item) => item.id),
    });
    this.userAdventures.delete(userId);
    adventure.memberIds = adventure.memberIds.filter((id) => id !== userId);
    delete adventure.healthByUser[userId];
    delete adventure.maxHealthByUser[userId];

    if (adventure.memberIds.length === 0) return this.end(client, adventure.id, reason);
    if (wasLeader) adventure.leaderId = adventure.memberIds[0];

    const guild = client.guilds.cache.get(adventure.guildId);
    const voiceChannel = guild?.channels.cache.get(adventure.voiceChannelId);
    const textChannel = guild?.channels.cache.get(adventure.textChannelId);
    await Promise.all([
      voiceChannel
        ? voiceChannel.permissionOverwrites.delete(userId, reason).catch(() => {})
        : Promise.resolve(),
      textChannel
        ? textChannel.permissionOverwrites.delete(userId, reason).catch(() => {})
        : Promise.resolve(),
    ]);
    if (textChannel) {
      const leaderMessage = wasLeader ? ` 새로운 공대장은 <@${adventure.leaderId}>님입니다.` : '';
      const penaltyMessage = reason === 'VOICE_CHANNEL_LEFT'
        ? ` 사망과 동일한 페널티로 이번 모험에서 획득한 장비 **${lostEquipment.length}개**를 잃었습니다.`
        : '';
      await textChannel
        .send(`🚪 <@${userId}>님이 모험에서 이탈했습니다.${penaltyMessage}${leaderMessage}`)
        .catch(() => {});
    }
    return true;
  }

  async handleVoiceStateUpdate(client, oldState, newState) {
    const adventure = this.getByUser(oldState.id);
    if (!adventure) return;
    if (oldState.channelId === adventure.voiceChannelId && newState.channelId !== adventure.voiceChannelId) {
      await this.removeMember(client, oldState.id, 'VOICE_CHANNEL_LEFT');
    }
  }

  async damage(client, userId, amount) {
    const adventure = this.getByUser(userId);
    if (!adventure) return null;

    adventure.healthByUser[userId] = roundHealth(
      adventure.healthByUser[userId] - Math.max(0, amount),
    );
    if (adventure.healthByUser[userId] === 0) {
      const guild = client.guilds.cache.get(adventure.guildId);
      const member = await guild?.members.fetch(userId).catch(() => null);
      await this.removeMember(client, userId, 'HEALTH_DEPLETED');
      if (member?.voice.channelId === adventure.voiceChannelId) {
        await member.voice.disconnect('체력이 0이 되어 모험 종료').catch(() => {});
      }
      return 0;
    }
    return adventure.healthByUser[userId];
  }

  healMissingHealth(userId, ratio = 0.5) {
    const adventure = this.getByUser(userId);
    if (!adventure) return null;

    const currentHealth = adventure.healthByUser[userId];
    const maxHealth = adventure.maxHealthByUser[userId];
    const recoveredHealth = roundHealth((maxHealth - currentHealth) * ratio);
    adventure.healthByUser[userId] = roundHealth(Math.min(maxHealth, currentHealth + recoveredHealth));
    return {
      before: currentHealth,
      after: adventure.healthByUser[userId],
      recovered: adventure.healthByUser[userId] - currentHealth,
      max: maxHealth,
    };
  }
}

export const adventureManager = new AdventureManager();
