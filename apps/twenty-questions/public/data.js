// 候補（動物 100 種）と質問、それに人手で付けた正解表。ブラウザと Node スクリプトの両方から読む。
// Jev は英語が主言語なので、Jev に渡すのは en、画面に出すのは ja。
// 正解表 TRUTH は Jev の回答の評価・シミュレーション用プレイヤー・MOCK 用の行列にだけ使い、実プレイの推論には使わない。

const MAMMALS = [
  ['dog', 'dog', 'イヌ'], ['cat', 'cat', 'ネコ'], ['horse', 'horse', 'ウマ'], ['cow', 'cow', 'ウシ'],
  ['pig', 'pig', 'ブタ'], ['sheep', 'sheep', 'ヒツジ'], ['goat', 'goat', 'ヤギ'], ['rabbit', 'rabbit', 'ウサギ'],
  ['mouse', 'mouse', 'ネズミ'], ['squirrel', 'squirrel', 'リス'], ['hamster', 'hamster', 'ハムスター'],
  ['lion', 'lion', 'ライオン'], ['tiger', 'tiger', 'トラ'], ['cheetah', 'cheetah', 'チーター'],
  ['leopard', 'leopard', 'ヒョウ'], ['elephant', 'elephant', 'ゾウ'], ['giraffe', 'giraffe', 'キリン'],
  ['zebra', 'zebra', 'シマウマ'], ['hippo', 'hippopotamus', 'カバ'], ['rhino', 'rhinoceros', 'サイ'],
  ['gorilla', 'gorilla', 'ゴリラ'], ['chimpanzee', 'chimpanzee', 'チンパンジー'],
  ['macaque', 'Japanese macaque (snow monkey)', 'ニホンザル'], ['brown_bear', 'brown bear', 'ヒグマ'],
  ['polar_bear', 'polar bear', 'ホッキョクグマ'], ['panda', 'giant panda', 'ジャイアントパンダ'],
  ['koala', 'koala', 'コアラ'], ['kangaroo', 'kangaroo', 'カンガルー'], ['wolf', 'wolf', 'オオカミ'],
  ['fox', 'fox', 'キツネ'], ['tanuki', 'raccoon dog (tanuki)', 'タヌキ'], ['deer', 'deer', 'シカ'],
  ['boar', 'wild boar', 'イノシシ'], ['camel', 'camel', 'ラクダ'], ['bat', 'bat', 'コウモリ'],
  ['dolphin', 'dolphin', 'イルカ'], ['orca', 'killer whale (orca)', 'シャチ'],
  ['blue_whale', 'blue whale', 'シロナガスクジラ'], ['seal', 'seal', 'アザラシ'],
  ['sea_otter', 'sea otter', 'ラッコ'], ['beaver', 'beaver', 'ビーバー'], ['hedgehog', 'hedgehog', 'ハリネズミ'],
  ['sloth', 'sloth', 'ナマケモノ'], ['platypus', 'platypus', 'カモノハシ'], ['reindeer', 'reindeer', 'トナカイ'],
  ['red_panda', 'red panda', 'レッサーパンダ'], ['capybara', 'capybara', 'カピバラ'],
];
const BIRDS = [
  ['chicken', 'chicken', 'ニワトリ'], ['duck', 'duck', 'アヒル'], ['swan', 'swan', 'ハクチョウ'],
  ['crow', 'crow', 'カラス'], ['sparrow', 'sparrow', 'スズメ'], ['pigeon', 'pigeon', 'ハト'],
  ['eagle', 'eagle', 'ワシ'], ['owl', 'owl', 'フクロウ'], ['penguin', 'penguin', 'ペンギン'],
  ['ostrich', 'ostrich', 'ダチョウ'], ['flamingo', 'flamingo', 'フラミンゴ'], ['parrot', 'parrot', 'オウム'],
  ['peacock', 'peacock', 'クジャク'], ['swallow', 'swallow (bird)', 'ツバメ'],
  ['woodpecker', 'woodpecker', 'キツツキ'], ['hummingbird', 'hummingbird', 'ハチドリ'],
  ['crane', 'red-crowned crane (bird)', 'ツル'],
];
const REPTILES = [
  ['crocodile', 'crocodile', 'ワニ'], ['sea_turtle', 'sea turtle', 'ウミガメ'], ['tortoise', 'tortoise', 'リクガメ'],
  ['cobra', 'cobra', 'コブラ'], ['chameleon', 'chameleon', 'カメレオン'], ['gecko', 'gecko', 'ヤモリ'],
];
const AMPHIBIANS = [['frog', 'frog', 'カエル'], ['newt', 'newt', 'イモリ']];
const FISH = [
  ['shark', 'great white shark', 'ホホジロザメ'], ['tuna', 'tuna', 'マグロ'], ['salmon', 'salmon', 'サケ'],
  ['goldfish', 'goldfish', 'キンギョ'], ['seahorse', 'seahorse', 'タツノオトシゴ'], ['eel', 'eel', 'ウナギ'],
  ['pufferfish', 'pufferfish', 'フグ'], ['manta', 'manta ray', 'マンタ'], ['anglerfish', 'anglerfish', 'アンコウ'],
];
const INSECTS = [
  ['butterfly', 'butterfly', 'チョウ'], ['honeybee', 'honeybee', 'ミツバチ'], ['ant', 'ant', 'アリ'],
  ['mosquito', 'mosquito', 'カ'], ['beetle', 'rhinoceros beetle', 'カブトムシ'], ['ladybug', 'ladybug', 'テントウムシ'],
  ['dragonfly', 'dragonfly', 'トンボ'], ['cicada', 'cicada', 'セミ'], ['firefly', 'firefly', 'ホタル'],
];
const OTHER_INVERTEBRATES = [
  ['octopus', 'octopus', 'タコ'], ['squid', 'squid', 'イカ'], ['crab', 'crab', 'カニ'], ['shrimp', 'shrimp', 'エビ'],
  ['jellyfish', 'jellyfish', 'クラゲ'], ['starfish', 'starfish', 'ヒトデ'], ['snail', 'snail', 'カタツムリ'],
  ['spider', 'spider', 'クモ'], ['scorpion', 'scorpion', 'サソリ'], ['earthworm', 'earthworm', 'ミミズ'],
];

const GROUPS = { MAMMALS, BIRDS, REPTILES, AMPHIBIANS, FISH, INSECTS, OTHER_INVERTEBRATES };
export const ANIMALS = Object.values(GROUPS).flat().map(([id, en, ja]) => ({ id, en, ja }));

const ids = (group) => group.map(([id]) => id);
const M = ids(MAMMALS), B = ids(BIRDS), R = ids(REPTILES), A = ids(AMPHIBIANS), F = ids(FISH), I = ids(INSECTS);
const INV = [...I, ...ids(OTHER_INVERTEBRATES)];
const without = (list, ...drop) => list.filter((id) => !drop.includes(id));
const w = (s) => s.split(/\s+/).filter(Boolean);

// yes: 明確に当てはまる / maybe: 種類や見方による（シミュレーションのプレイヤーは「わからない」と答える）/ それ以外は no
export const QUESTIONS = [
  { id: 'mammal', en: 'Is this animal a mammal?', ja: '哺乳類ですか？', yes: M },
  { id: 'bird', en: 'Is this animal a bird?', ja: '鳥ですか？', yes: B },
  { id: 'reptile', en: 'Is this animal a reptile?', ja: '爬虫類ですか？', yes: R },
  { id: 'fish', en: 'Is this animal a fish?', ja: '魚ですか？', yes: F },
  { id: 'insect', en: 'Is this animal an insect?', ja: '昆虫ですか？', yes: I },
  { id: 'invertebrate', en: 'Is this animal an invertebrate (an animal without a backbone)?', ja: '背骨のない動物（無脊椎動物）ですか？', yes: INV },
  {
    id: 'fly', en: 'Can this animal fly?', ja: '空を飛べますか？',
    yes: [...without(B, 'penguin', 'ostrich', 'chicken', 'peacock'), 'bat', ...without(I, 'ant')],
    maybe: w('chicken peacock ant'),
  },
  { id: 'wings', en: 'Does this animal have wings?', ja: '翼や羽（はね）がありますか？', yes: [...B, 'bat', ...without(I, 'ant')], maybe: w('ant') },
  {
    id: 'water', en: 'Does this animal live mainly in water?', ja: '主に水の中で暮らしていますか？',
    yes: [...w('dolphin orca blue_whale sea_otter sea_turtle octopus squid shrimp jellyfish starfish'), ...F],
    maybe: w('seal hippo beaver platypus penguin crocodile frog newt crab duck swan'),
  },
  {
    id: 'sea', en: 'Does this animal live in the sea (salt water)?', ja: '海にすんでいますか？',
    yes: w('dolphin orca blue_whale seal sea_otter sea_turtle shark tuna seahorse pufferfish manta anglerfish octopus squid crab jellyfish starfish'),
    maybe: w('penguin polar_bear salmon eel shrimp'),
  },
  {
    id: 'freshwater', en: 'Does this animal live in fresh water such as rivers, lakes, or ponds?', ja: '川・湖・池などの淡水にすんでいますか？',
    yes: w('hippo beaver platypus capybara duck swan crocodile frog newt goldfish'),
    maybe: w('salmon eel crane flamingo dragonfly mosquito crab shrimp snail firefly'),
  },
  {
    id: 'eggs', en: 'Does this animal reproduce by laying eggs?', ja: '卵を産みますか？',
    yes: [...B, ...R, ...A, ...without(F, 'shark', 'manta'), ...without(INV, 'scorpion'), 'platypus'],
    maybe: w('shark manta scorpion'),
  },
  {
    id: 'fur', en: 'Is the body of this animal covered with fur or hair?', ja: '体が毛（毛皮）でおおわれていますか？',
    yes: without(M, 'dolphin', 'orca', 'blue_whale', 'elephant', 'hippo', 'rhino', 'pig', 'hedgehog'),
    maybe: w('elephant hippo rhino pig hedgehog'),
  },
  {
    id: 'shell', en: 'Does this animal have a hard shell covering its body?', ja: '体をおおう硬い甲羅や殻がありますか？',
    yes: w('sea_turtle tortoise crab shrimp snail'), maybe: w('beetle ladybug scorpion starfish'),
  },
  {
    id: 'legs4', en: 'Does this animal walk on four legs?', ja: '4本足で歩きますか？',
    yes: [...without(M, 'bat', 'dolphin', 'orca', 'blue_whale', 'seal', 'kangaroo', 'gorilla', 'chimpanzee', 'macaque', 'sea_otter', 'sloth'), ...w('crocodile tortoise chameleon gecko newt')],
    maybe: w('kangaroo gorilla chimpanzee macaque sea_otter sloth sea_turtle frog'),
  },
  {
    id: 'legs_none', en: 'Does this animal have no legs at all?', ja: '足がまったくありませんか？',
    yes: [...F, ...w('cobra dolphin orca blue_whale jellyfish snail earthworm')], maybe: w('seal starfish octopus squid'),
  },
  {
    id: 'legs6', en: 'Does this animal have six or more legs?', ja: '足が6本以上ありますか？',
    yes: [...I, ...w('spider scorpion crab shrimp')], maybe: w('octopus squid'),
  },
  {
    id: 'bigger_human', en: 'Is a typical adult of this animal larger than an adult human?', ja: '大人の人間より大きいですか？',
    yes: w('horse cow lion tiger elephant giraffe zebra hippo rhino gorilla brown_bear polar_bear camel dolphin orca blue_whale crocodile shark manta ostrich reindeer'),
    maybe: w('pig cheetah leopard panda deer boar kangaroo seal tuna sea_turtle tortoise chimpanzee cobra squid octopus'),
  },
  {
    id: 'smaller_cat', en: 'Is a typical adult of this animal smaller than a house cat?', ja: 'ネコより小さいですか？',
    yes: [...w('mouse squirrel hamster bat hedgehog sparrow pigeon swallow woodpecker hummingbird chameleon gecko frog newt goldfish seahorse'), ...without(INV, 'octopus', 'squid', 'jellyfish')],
    maybe: w('rabbit platypus duck chicken owl parrot crow eel tortoise cobra pufferfish octopus squid jellyfish'),
  },
  {
    id: 'palm', en: 'Is a typical adult of this animal small enough to sit on a human palm?', ja: '手のひらに乗るくらい小さいですか？',
    yes: [...w('mouse hamster sparrow hummingbird gecko frog newt goldfish seahorse spider scorpion snail earthworm shrimp'), ...I],
    maybe: w('swallow crab starfish bat chameleon squirrel jellyfish hedgehog'),
  },
  {
    id: 'carnivore', en: 'Does this animal mainly eat other animals (meat, fish, or insects)?', ja: '主にほかの動物（肉・魚・虫）を食べますか？',
    yes: w('cat lion tiger cheetah leopard polar_bear wolf fox dolphin orca blue_whale seal sea_otter hedgehog platypus eagle owl penguin swallow woodpecker crocodile cobra chameleon gecko frog newt shark tuna salmon seahorse eel pufferfish manta anglerfish octopus squid jellyfish starfish spider scorpion ladybug dragonfly'),
    maybe: w('dog bat brown_bear tanuki crane crow duck flamingo chicken sea_turtle goldfish crab shrimp firefly mosquito ant boar pig mouse sparrow chimpanzee'),
  },
  {
    id: 'herbivore', en: 'Does this animal mainly eat plants?', ja: '主に植物を食べますか？',
    yes: w('horse cow sheep goat rabbit squirrel elephant giraffe zebra hippo rhino gorilla panda koala kangaroo deer camel beaver sloth reindeer red_panda capybara swan pigeon parrot hummingbird tortoise snail butterfly honeybee cicada beetle'),
    maybe: w('hamster mouse pig boar macaque chimpanzee brown_bear tanuki ostrich peacock sparrow chicken duck sea_turtle goldfish earthworm ant crow crane flamingo mosquito'),
  },
  {
    id: 'pet', en: 'Is this animal commonly kept as a pet at home?', ja: '家でペットとしてよく飼われますか？',
    yes: w('dog cat rabbit hamster parrot goldfish tortoise'),
    maybe: w('mouse gecko hedgehog horse chicken pigeon chameleon frog newt beetle duck squirrel shrimp seahorse'),
  },
  {
    id: 'farm', en: 'Is this animal commonly raised on farms as livestock?', ja: '家畜として農場でよく飼われますか？',
    yes: w('horse cow pig sheep goat chicken duck'), maybe: w('rabbit camel reindeer ostrich honeybee salmon deer shrimp eel'),
  },
  {
    id: 'africa', en: 'Is this animal typically found in the African savanna?', ja: 'アフリカのサバンナにいる動物ですか？',
    yes: w('lion cheetah leopard elephant giraffe zebra hippo rhino ostrich'),
    maybe: w('gorilla chimpanzee crocodile flamingo cobra camel eagle scorpion chameleon'),
  },
  {
    id: 'australia', en: 'Is this animal native to Australia and strongly associated with it?', ja: 'オーストラリアを代表する動物ですか？',
    yes: w('koala kangaroo platypus'), maybe: w('crocodile parrot'),
  },
  {
    id: 'dangerous', en: 'Is this animal generally considered dangerous to humans?', ja: '人間にとって危険な動物ですか？',
    yes: w('lion tiger leopard hippo rhino brown_bear polar_bear crocodile cobra shark scorpion'),
    maybe: w('mosquito jellyfish pufferfish elephant cheetah wolf orca gorilla boar honeybee spider chimpanzee kangaroo ostrich octopus dog'),
  },
  {
    id: 'nocturnal', en: 'Is this animal mainly active at night?', ja: '主に夜に活動しますか？',
    yes: w('bat owl hedgehog tanuki mouse hamster gecko firefly platypus beaver scorpion eel beetle'),
    maybe: w('koala leopard lion tiger fox wolf cat boar red_panda sloth anglerfish frog newt snail spider mosquito earthworm cobra octopus hippo capybara rabbit deer crab'),
  },
  {
    id: 'pattern', en: 'Does this animal have a distinctive pattern of stripes or spots on its body?', ja: '体に目立つしま模様や斑点がありますか？',
    yes: w('tiger cheetah leopard giraffe zebra ladybug honeybee'),
    maybe: w('cow deer boar panda orca red_panda tanuki cobra gecko butterfly pufferfish owl woodpecker peacock frog newt seal cat dog squirrel mosquito spider'),
  },
  {
    id: 'horns', en: 'Does this animal have horns, antlers, or tusks?', ja: '角（つの）や牙（きば）がありますか？',
    yes: w('cow goat elephant rhino deer boar reindeer giraffe beetle'), maybe: w('sheep hippo chameleon snail'),
  },
  {
    id: 'cold', en: 'Does this animal live in cold, snowy, or polar regions?', ja: '寒い地域や雪の多い地域にすんでいますか？',
    yes: w('polar_bear penguin reindeer seal'),
    maybe: w('wolf fox brown_bear orca blue_whale sea_otter owl salmon crane swan deer macaque red_panda eagle rabbit beaver'),
  },
  {
    id: 'trees', en: 'Does this animal spend much of its time in trees?', ja: '木の上で過ごすことが多いですか？',
    yes: w('squirrel koala sloth red_panda chimpanzee macaque owl woodpecker parrot chameleon cicada beetle'),
    maybe: w('gorilla leopard bat crow sparrow eagle gecko frog cobra spider pigeon hummingbird ant panda cat'),
  },
  {
    id: 'venom', en: 'Is this animal venomous or poisonous?', ja: '毒を持っていますか？',
    yes: w('cobra scorpion spider jellyfish pufferfish honeybee'), maybe: w('platypus octopus newt frog ant ladybug starfish'),
  },
  {
    id: 'eaten', en: 'Is this animal commonly eaten by people as food?', ja: '食べ物として人によく食べられていますか？',
    yes: w('cow pig sheep goat chicken duck tuna salmon eel octopus squid crab shrimp'),
    maybe: w('rabbit horse deer boar reindeer camel kangaroo ostrich pigeon pufferfish shark jellyfish snail frog crocodile sea_turtle anglerfish sparrow'),
  },
  {
    id: 'group', en: 'Does this animal typically live in groups such as herds, packs, flocks, or colonies?', ja: '群れで暮らすことが多いですか？',
    yes: w('horse cow sheep goat lion elephant zebra hippo gorilla chimpanzee macaque wolf deer bat dolphin orca seal reindeer capybara kangaroo chicken duck crow sparrow pigeon penguin flamingo parrot tuna honeybee ant'),
    maybe: w('dog pig giraffe boar camel sea_otter mouse rabbit swan ostrich swallow crane salmon goldfish squid shrimp mosquito jellyfish blue_whale beaver firefly crocodile cheetah tanuki manta'),
  },
  {
    id: 'jump', en: 'Is this animal well known for jumping or hopping?', ja: 'ジャンプしたり跳ねたりすることで有名ですか？',
    yes: w('rabbit kangaroo frog'), maybe: w('squirrel dolphin cat deer horse salmon macaque mouse goat spider orca manta shrimp'),
  },
  {
    id: 'fast', en: 'Is this animal well known for being very fast?', ja: 'とても速いことで有名ですか？',
    yes: w('cheetah horse eagle swallow tuna ostrich rabbit dragonfly hummingbird'),
    maybe: w('dolphin lion tiger leopard zebra wolf dog deer kangaroo fox shark bat orca salmon squid pigeon cat mouse squirrel gecko reindeer boar camel'),
  },
  {
    id: 'slow', en: 'Is this animal well known for being slow?', ja: '動きが遅いことで有名ですか？',
    yes: w('sloth tortoise snail koala starfish chameleon seahorse'),
    maybe: w('sea_turtle earthworm panda jellyfish elephant capybara cow hedgehog newt ladybug anglerfish pufferfish penguin'),
  },
  {
    id: 'long_neck', en: 'Does this animal have a notably long neck?', ja: '首が目立って長いですか？',
    yes: w('giraffe swan ostrich flamingo crane camel'), maybe: w('tortoise horse deer duck peacock'),
  },
  {
    id: 'black_white', en: 'Is the body of this animal mainly black and white?', ja: '体の色は主に白と黒ですか？',
    yes: w('panda zebra penguin orca'), maybe: w('cow swallow crane woodpecker dog cat manta mosquito goat rabbit eagle'),
  },
  {
    id: 'colorful', en: 'Is this animal well known for a brightly colored appearance?', ja: '色あざやかな見た目で有名ですか？',
    yes: w('parrot peacock flamingo butterfly ladybug goldfish chameleon hummingbird'),
    maybe: w('seahorse starfish frog woodpecker duck dragonfly jellyfish newt gecko octopus red_panda tiger fox crab shrimp salmon'),
  },
  {
    id: 'burrow', en: 'Does this animal dig burrows or live underground?', ja: '巣穴を掘ったり地中で暮らしたりしますか？',
    yes: w('rabbit mouse hamster fox ant earthworm platypus scorpion'),
    maybe: w('tanuki wolf hedgehog crab spider cicada beetle brown_bear polar_bear penguin owl squirrel beaver tortoise eel octopus shrimp frog cobra'),
  },
  {
    id: 'hooves', en: 'Does this animal have hooves?', ja: 'ひづめがありますか？',
    yes: w('horse cow pig sheep goat giraffe zebra rhino deer boar reindeer'), maybe: w('hippo camel elephant'),
  },
  {
    id: 'metamorphosis', en: 'Does this animal go through metamorphosis, changing body form from a larva to an adult?', ja: '幼虫やオタマジャクシから姿を変えて大人になりますか（変態）？',
    yes: [...I, ...A], maybe: w('jellyfish crab shrimp eel starfish'),
  },
];

// TRUTH[animalIndex][questionIndex] = 1 (yes) / 0.5 (maybe) / 0 (no)
export const TRUTH = ANIMALS.map(({ id }) =>
  QUESTIONS.map((q) => (q.yes.includes(id) ? 1 : q.maybe?.includes(id) ? 0.5 : 0)),
);

// データの打ち間違い検出用。存在しない id と、yes/maybe の重複を返す。
export function validateData() {
  const known = new Set(ANIMALS.map((a) => a.id));
  const problems = [];
  if (known.size !== ANIMALS.length) problems.push('動物 id が重複している');
  for (const q of QUESTIONS) {
    for (const id of [...q.yes, ...(q.maybe ?? [])]) if (!known.has(id)) problems.push(`${q.id}: 未知の id "${id}"`);
    for (const id of q.maybe ?? []) if (q.yes.includes(id)) problems.push(`${q.id}: "${id}" が yes と maybe の両方にある`);
  }
  return problems;
}
