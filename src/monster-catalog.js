export const DUNGEON_REGIONS = [
  ['이끼 낀 폐허', '청록 슬라임', '고대 석상왕', '산성 몸통박치기', '대지의 심판', 'moss-slime.png', 'ancient-idol-king.png'],
  ['균사 동굴', '포자 야수', '균사 여왕', '독성 포자', '만개하는 역병', 'spore-beast.png', 'mycelium-queen.png'],
  ['망자의 묘지', '해골 기사', '백골 군주', '녹슨 참격', '망자의 대행진', 'skeleton-knight.png', 'bone-lord.png'],
  ['핏빛 성채', '혈맹 가고일', '진홍 백작', '피의 발톱', '핏빛 월식', 'blood-gargoyle.png', 'crimson-count.png'],
  ['침수된 신전', '심해 사냥꾼', '해일의 사제', '물살 찌르기', '심해의 대홍수', 'deep-hunter.png', 'tide-priest.png'],
  ['용암 광산', '마그마 골렘', '화산의 거인', '용암 주먹', '분화의 격노', 'magma-golem.png', 'volcanic-titan.png'],
  ['얼어붙은 궁전', '서리 망령', '빙결 여제', '빙하의 손길', '영원의 눈보라', 'frost-wraith.png', 'frozen-empress.png'],
  ['폭풍 첨탑', '뇌운 와이번', '폭풍 군주', '번개 강하', '천둥의 종언', 'storm-wyvern.png', 'tempest-lord.png'],
  ['독기의 늪', '맹독 히드라', '늪지 마녀', '독니 연격', '부패의 가마솥', 'venom-hydra.png', 'swamp-witch.png'],
  ['태엽 공방', '기계 파수병', '태엽 대장군', '톱니 난사', '과부하 섬멸포', 'clockwork-sentinel.png', 'clockwork-general.png'],
  ['수정 협곡', '수정 전갈', '찬란한 결정룡', '수정 꼬리침', '프리즘 붕괴', 'crystal-scorpion.png', 'prismatic-dragon.png'],
  ['환영 미궁', '거울 도플갱어', '천면의 환술사', '거울 베기', '무한 환영진', 'mirror-doppelganger.png', 'master-illusionist.png'],
  ['모래시계 사막', '사막 포식자', '시간의 파라오', '모래 송곳니', '시간 매장', 'dune-devourer.png', 'time-pharaoh.png'],
  ['별빛 관측소', '성운 포식체', '별의 예언자', '별조각 투사', '초신성 계시', 'nebula-devourer.png', 'astral-oracle.png'],
  ['공허 균열', '공허 추적자', '차원의 폭군', '공간 절단', '차원 붕괴', 'void-stalker.png', 'dimensional-tyrant.png'],
  ['고룡의 둥지', '용혈 기사', '고룡 카르바논', '용아 찌르기', '태고의 용염', 'dragonblood-knight.png', 'elder-dragon.png'],
  ['천공의 성역', '천공 집행자', '타락한 대천사', '빛의 처단', '낙원의 추락', 'sky-executor.png', 'fallen-archangel.png'],
  ['마왕의 요새', '마계 근위병', '마왕 아자르', '암흑 대검', '마계 멸망진', 'demon-guard.png', 'demon-king.png'],
  ['신들의 무덤', '신살자 망령', '잊힌 전쟁신', '영혼 파쇄', '신역 파괴', 'godslayer-wraith.png', 'forgotten-war-god.png'],
  ['세계의 끝', '종말의 사도', '심연의 군주', '종말의 낫', '세계 종언', 'apocalypse-herald.png', 'abyss-overlord.png'],
].map(([regionName, normalName, bossName, normalSkill, bossSkill, normalImage, bossImage], index) => ({
  id: index + 1,
  minFloor: index * 5 + 1,
  maxFloor: index * 5 + 5,
  regionName,
  normal: { name: normalName, skillName: normalSkill, image: normalImage },
  boss: { name: bossName, skillName: bossSkill, image: bossImage },
}));

export function getDungeonRegion(floor) {
  const normalizedFloor = Math.min(100, Math.max(1, Math.floor(floor)));
  return DUNGEON_REGIONS[Math.floor((normalizedFloor - 1) / 5)];
}

export function isImplementedFloor(floor) {
  return Number.isInteger(floor) && floor >= 1 && floor <= 100;
}
