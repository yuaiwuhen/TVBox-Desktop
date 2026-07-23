const fs = require('fs');
const LOG = 'D:\\Code\\TVBOXDesktop\\dev.log';
const log = fs.readFileSync(LOG, 'utf-8');
const lines = log.split('\n');

// Sources to investigate
const sources = [
  'Bili', 'NewPanMe123', 'WexJianPian', 'WexIkanBot', 'LiveBiLi',
  'DuanJuHeMa', 'ChildrenDuoDuo', 'ChildrenBaoBao', 'ChildrenBeiWa', 'ChildrenTuTu',
  'WexTangDou', 'MusicLiYuan', 'MusicIKtv',
  'SportFeiQiu', 'SportKanQiuTong',
  'WexWenCai', 'WexV6DaShiXiong', 'WexV6TeGou',
  'ManJuHongGuo', 'AnimeFanShu', 'AnimeMiaoWu',
  'Emby', 'AList', 'WebDAV', 'DiyVod', 'MyGuangYa',
  'SoTySo', 'SoBaiDuSo', 'SoHaiYin', 'So97So',
  'Push'
];

// Find last occurrence of each source's homeContent call and show context
for (const src of sources) {
  console.log('\n=== ' + src + ' ===');
  // Find lines mentioning this source
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(src + 'Guard') || lines[i].includes(src + '-') || lines[i].includes('spider.' + src)) {
      matches.push(i);
    }
  }
  if (matches.length === 0) {
    console.log('  (no logs)');
    continue;
  }
  // Show last 15 matches' lines
  const last = matches.slice(-15);
  for (const idx of last) {
    const l = lines[idx].substring(0, 200);
    console.log('  L' + idx + ': ' + l);
  }
}
