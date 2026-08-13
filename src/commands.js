import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('가이드북')
    .setDescription('처음 시작하는 플레이어를 위한 던전 게임 안내입니다.'),
  new SlashCommandBuilder()
    .setName('도움말')
    .setDescription('명령어와 확률, 버프, 디버프 정보를 확인합니다.')
    .addStringOption((option) =>
      option
        .setName('항목')
        .setDescription('확인할 도움말 항목')
        .addChoices(
          { name: '확률 정보', value: '확률' },
          { name: '버프 종류', value: '버프' },
          { name: '디버프 종류', value: '디버프' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('아이템이름')
        .setDescription('정보를 확인할 포션, 장비 또는 스킬')
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('봇이 정상적으로 작동하는지 확인합니다.'),
  new SlashCommandBuilder()
    .setName('게임시작')
    .setDescription('가위바위보 게임을 시작합니다.'),
  new SlashCommandBuilder()
    .setName('내정보')
    .setDescription('내 던전 캐릭터의 스탯과 장비를 확인합니다.'),
  new SlashCommandBuilder()
    .setName('랭킹')
    .setDescription('레벨, 탑 또는 스탯별 플레이어 순위를 확인합니다.')
    .addSubcommand((subcommand) => subcommand.setName('레벨').setDescription('플레이어 레벨 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('탑').setDescription('최대 도달 층 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('체력').setDescription('최대 체력 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('방어력').setDescription('방어력 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('공격력').setDescription('공격력 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('마법공격력').setDescription('마법 공격력 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('마나').setDescription('최대 마나 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('속도').setDescription('속도 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('치명타확률').setDescription('치명타 확률 순위를 확인합니다.'))
    .addSubcommand((subcommand) => subcommand.setName('치명타피해').setDescription('치명타 피해 순위를 확인합니다.')),
  new SlashCommandBuilder()
    .setName('파티원스텟')
    .setDescription('모험 중인 파티원 전체의 현재 스탯을 확인합니다.'),
  new SlashCommandBuilder()
    .setName('정보')
    .setDescription('다른 플레이어의 스탯과 장착 장비를 확인합니다.')
    .addUserOption((option) =>
      option.setName('플레이어').setDescription('정보를 확인할 플레이어').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('장비인벤토리')
    .setDescription('보유 장비와 마석 등 강화 재료를 확인합니다.'),
  new SlashCommandBuilder()
    .setName('아이템인벤토리')
    .setDescription('던전에서 사용할 수 있는 소비 아이템을 확인합니다.'),
  new SlashCommandBuilder()
    .setName('스킬북')
    .setDescription('장착 중인 스킬 3개와 현재 보유 스킬을 확인합니다.'),
  new SlashCommandBuilder()
    .setName('스킬도감')
    .setDescription('전체 스킬을 보유 중인 스킬과 미보유 스킬로 나누어 확인합니다.'),
  new SlashCommandBuilder()
    .setName('스킬제작')
    .setDescription('같은 등급의 스킬 조각 10개로 새로운 스킬을 제작합니다.')
    .addStringOption((option) =>
      option
        .setName('등급')
        .setDescription('제작할 스킬의 등급')
        .setRequired(true)
        .addChoices(
          { name: '일반', value: '일반' },
          { name: '고급', value: '고급' },
          { name: '레어', value: '레어' },
          { name: '전설', value: '전설' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('적도감')
    .setDescription('던전에 등장하는 적의 서식 층수와 상세 정보를 확인합니다.')
    .addStringOption((option) =>
      option
        .setName('적이름')
        .setDescription('상세 정보를 확인할 적을 선택하세요.')
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('스킬장착')
    .setDescription('보유 스킬을 최대 3개의 슬롯 중 하나에 장착합니다.')
    .addStringOption((option) =>
      option
        .setName('스킬')
        .setDescription('장착할 스킬을 선택하세요.')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('슬롯')
        .setDescription('스킬을 장착할 슬롯입니다.')
        .setRequired(true)
        .addChoices(
          { name: '1번 슬롯', value: 1 },
          { name: '2번 슬롯', value: 2 },
          { name: '3번 슬롯', value: 3 },
        ),
    ),
  new SlashCommandBuilder()
    .setName('스킬장착해제')
    .setDescription('장착 중인 스킬 슬롯을 비웁니다.')
    .addIntegerOption((option) =>
      option
        .setName('슬롯')
        .setDescription('장착 해제할 스킬 슬롯입니다.')
        .setRequired(true)
        .addChoices(
          { name: '1번 슬롯', value: 1 },
          { name: '2번 슬롯', value: 2 },
          { name: '3번 슬롯', value: 3 },
        ),
    ),
  new SlashCommandBuilder()
    .setName('상점')
    .setDescription('골드로 체력 및 마나 포션을 구매합니다.'),
  new SlashCommandBuilder()
    .setName('장비장착')
    .setDescription('인벤토리의 장비를 장착합니다.')
    .addStringOption((option) =>
      option
        .setName('아이템이름')
        .setDescription('인벤토리에서 장착할 장비를 선택하세요.')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('자동장착')
    .setDescription('내 레벨 이하 장비 중 가장 좋은 장비를 자동 장착합니다.'),
  new SlashCommandBuilder()
    .setName('장비강화')
    .setDescription('보유 또는 장착 중인 장비를 한 단계 강화합니다.')
    .addStringOption((option) =>
      option
        .setName('아이템이름')
        .setDescription('강화할 장비를 선택하세요.')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('장비분해')
    .setDescription('장비 인벤토리의 장비를 분해하여 마석을 획득합니다.')
    .addStringOption((option) =>
      option
        .setName('장비')
        .setDescription('분해할 장비를 선택하세요.')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('장비일괄분해')
    .setDescription('고유 레벨 또는 등급 조건에 맞는 잠금 해제 장비를 일괄 분해합니다.')
    .addIntegerOption((option) =>
      option
        .setName('고유레벨이하')
        .setDescription('이 고유 레벨 이하의 장비만 분해합니다.')
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addStringOption((option) =>
      option
        .setName('등급이하')
        .setDescription('선택한 등급 이하의 장비만 분해합니다.')
        .addChoices(
          { name: '일반 이하', value: '일반' },
          { name: '고급 이하', value: '고급' },
          { name: '레어 이하', value: '레어' },
          { name: '전설 이하', value: '전설' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('장비잠금')
    .setDescription('장비를 잠그거나 잠금을 해제합니다.')
    .addStringOption((option) =>
      option
        .setName('장비')
        .setDescription('잠금 상태를 변경할 장비를 선택하세요.')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName('상태')
        .setDescription('적용할 잠금 상태를 선택하세요.')
        .setRequired(true)
        .addChoices(
          { name: '잠금', value: 'lock' },
          { name: '잠금 해제', value: 'unlock' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('모험시작')
    .setDescription('던전입장 음성 채널에서 1층 또는 체크포인트 모험을 시작합니다.'),
  new SlashCommandBuilder()
    .setName('모험중지')
    .setDescription('진행 중인 모험을 종료하거나 파티 종료 투표를 시작합니다.'),
  new SlashCommandBuilder()
    .setName('결투신청')
    .setDescription('같은 음성 채널에 있는 플레이어에게 PVP 결투를 신청합니다.')
    .addUserOption((option) =>
      option.setName('상대').setDescription('결투를 신청할 플레이어').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('항복')
    .setDescription('진행 중인 PVP 결투에서 항복하고 상대방의 승리로 종료합니다.'),
  new SlashCommandBuilder()
    .setName('전체초기화')
    .setDescription('모든 플레이어의 캐릭터, 장비 및 인벤토리를 초기화합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('확인')
        .setDescription('실행하려면 "전체초기화"를 정확히 입력하세요.')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('give')
    .setDescription('선택한 플레이어에게 디버그용 아이템을 지급합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option.setName('플레이어').setDescription('아이템을 받을 플레이어').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('아이템')
        .setDescription('지급할 포션, 장비, 스킬, 재화 또는 스킬 조각')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('수량')
        .setDescription('지급 수량 (기본값 1)')
        .setMinValue(1)
        .setMaxValue(1_000_000),
    ),
  new SlashCommandBuilder()
    .setName('디버그')
    .setDescription('관리자용 게임 디버그 명령어입니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup((group) =>
      group
        .setName('모험')
        .setDescription('던전 모험을 디버그합니다.')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('다음층이동')
            .setDescription('현재 모험을 강제로 다음 층으로 이동시킵니다.'),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('킬')
            .setDescription('현재 전투 중인 몬스터를 즉시 처치합니다.'),
        ),
    ),
].map((command) => command.toJSON());
