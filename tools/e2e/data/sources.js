/**
 * 所有内容源定义
 *
 * 每个源包含:
 * - key: 源唯一标识
 * - api: spider 类名
 * - ext: 扩展配置
 * - name: 显示名称
 */
const SOURCES = [
  {
    key: '豆瓣',
    api: 'csp_Douban',
    ext: '',
    name: '豆瓣',
    category: '影视推荐',
  },
  {
    key: 'config',
    api: 'csp_Config',
    ext: '',
    name: '配置中心',
    category: '系统',
  },
  {
    key: 'csp_FeiMaoUC',
    api: 'csp_Duopan',
    ext: '{"site_urls":["http://shandian.blog/","http://sd.sduc.site/"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"FeiMaoUC"}',
    name: '飞猫UC',
    category: '网盘聚合',
  },
  {
    key: 'csp_Duopan',
    api: 'csp_Duopan',
    ext: '{"site_urls":["http://tvpanpan.site","http://feimo.fun","http://xiaocgege.shop","http://www.xiaocgege.shop","https://www.xiaocge.fun"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"Duopan2"}',
    name: '多盘',
    category: '网盘聚合',
  },
  {
    key: 'csp_Netfixtv',
    api: 'csp_Duopan',
    ext: '{"site_urls":["https://www.zhizhen8.click","https://pan.mihdr.top","https://www.zhizhen1.top","https://www.mihdr.top","https://www.miqk.cc"],"url_key":"Netfixtv2","threadinfo":{"chunksize":512,"threads":16}}',
    name: 'NetFlixTV',
    category: '网盘聚合',
  },
  {
    key: '潮流',
    api: 'csp_AppRJ',
    ext: 'http://v.rbotv.cn',
    name: '潮流',
    category: '影视',
  },
  {
    key: '行动',
    api: 'csp_AppQi',
    ext: 'https://qj4.catbb.xyz|eecbio48dsq13kkk',
    name: '行动',
    category: '影视',
  },
  {
    key: '一碗',
    api: 'csp_AppGet',
    ext: 'https://app.95112475.xyz|5a9w6x58dsq6z3a6',
    name: '一碗',
    category: '影视',
  },
  {
    key: '蔬菜',
    api: 'csp_AppGet',
    ext: 'https://gitee.com/wmmoliill/wimg/raw/master/img/bk/9.txt|88689667dce61725',
    name: '蔬菜',
    category: '影视',
  },
  {
    key: 'csp_Jpys',
    api: 'csp_Jpys',
    ext: '',
    name: '极速影视',
    category: '影视',
  },
  {
    key: 'csp_Wwys',
    api: 'csp_Wwys',
    ext: 'https://vip.wwgz.cn:5200',
    name: '旺旺影视',
    category: '影视',
  },
  {
    key: '荐片',
    api: 'csp_Jianpian',
    ext: 'https://api.ztcgi.com',
    name: '荐片',
    category: '影视',
  },
  {
    key: 'csp_SaoHuo',
    api: 'csp_SaoHuo',
    ext: 'https://shdy5.us',
    name: '扫火',
    category: '影视',
  },
  {
    key: 'csp_Gz360',
    api: 'csp_Gz360',
    ext: '',
    name: '瓜子360',
    category: '影视',
  },
  {
    key: 'csp_SP360',
    api: 'csp_SP360',
    ext: '',
    name: '360视频',
    category: '影视',
  },
  {
    key: 'csp_Bili',
    api: 'csp_Bili',
    ext: '{"json":"https://nos.netease.com/ysf/0075389dca9afadd4614e9713765ff17.txt","cookie":""}',
    name: 'B站',
    category: 'B站',
  },
  {
    key: 'csp_Dm84',
    api: 'csp_Dm84',
    ext: 'https://dm84.net',
    name: '动漫84',
    category: '动漫',
  },
  {
    key: '方舟',
    api: 'csp_AppGet',
    ext: 'https://www.cyfz.top|e72cdfd629e8895d',
    name: '方舟',
    category: '影视',
  },
  {
    key: '番薯',
    api: 'csp_AppGet',
    ext: 'https://new.app.bytegooty.com|N4yj7l7xKxHF4*gz',
    name: '番薯',
    category: '影视',
  },
  {
    key: 'csp_FirstAid',
    api: 'csp_FirstAid',
    ext: '',
    name: '急救',
    category: '教育',
  },
  {
    key: '酷狗',
    api: 'csp_Kugou',
    ext: '{"classes":[{"type_name":"酷狗","type_id":"kugou"}]}',
    name: '酷狗音乐',
    category: '音乐',
  },
  {
    key: 'MTV',
    api: 'csp_Bili',
    ext: '{"json":"https://img2.gelonghui.com/library/2b4eb-8fb08a6b-f9f1-48d8-816a-1bc712a85fefnull","cookie":""}',
    name: 'MTV',
    category: '音乐',
  },
  {
    key: '看球',
    api: 'csp_Kanqiu',
    ext: '',
    name: '看球',
    category: '体育',
  },
  {
    key: '瓜子',
    api: 'csp_GuaziTY',
    ext: '',
    name: '瓜子',
    category: '体育',
  },
  {
    key: '米搜',
    api: 'csp_MiSou',
    ext: 'http://127.0.0.1:9978/file/fatcat/kk.txt',
    name: '米搜',
    category: '网盘搜索',
  },
  {
    key: 'csp_少儿',
    api: 'csp_Bili',
    ext: '{"json":"https://img2.gelonghui.com/library/1903b-eb0f1675-2437-4e72-bcf0-427b1626d79fnull","cookie":""}',
    name: '少儿教育',
    category: '教育',
  },
  {
    key: 'csp_小学',
    api: 'csp_Bili',
    ext: '{"json":"https://img2.gelonghui.com/library/a1140-144855fe-3eaa-44f3-b689-6812c233de54null","cookie":""}',
    name: '小学课程',
    category: '教育',
  },
  {
    key: 'csp_初中',
    api: 'csp_Bili',
    ext: '{"json":"https://img2.gelonghui.com/library/ba156-73e16cad-8257-4f33-b8c0-e051e72e546dnull","cookie":""}',
    name: '初中课程',
    category: '教育',
  },
  {
    key: 'csp_高中',
    api: 'csp_Bili',
    ext: '{"json":"https://img2.gelonghui.com/library/e44b3-4a82ab48-e014-49b2-bb66-ee5207e8f195null","cookie":""}',
    name: '高中课程',
    category: '教育',
  },
];

/**
 * 网盘源专项测试目标
 */
const PAN_TESTS = [
  {
    label: '夸克网盘',
    panType: 'quark',
    siteKey: 'csp_FeiMaoUC',
    api: 'csp_Duopan',
    ext: '{"site_urls":["http://shandian.blog/","http://sd.sduc.site/"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"FeiMaoUC"}',
    flagKeywords: ['夸克', 'quark', 'Quark'],
  },
  {
    label: '百度网盘',
    panType: 'baidu',
    siteKey: 'csp_Duopan',
    api: 'csp_Duopan',
    ext: '{"site_urls":["http://tvpanpan.site","http://feimo.fun","http://xiaocgege.shop","http://www.xiaocgege.shop","https://www.xiaocge.fun"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"Duopan2"}',
    flagKeywords: ['百度', 'baidu', 'B度', 'Baidu'],
  },
  {
    label: 'UC网盘',
    panType: 'uc',
    siteKey: 'csp_FeiMaoUC',
    api: 'csp_Duopan',
    ext: '{"site_urls":["http://shandian.blog/","http://sd.sduc.site/"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"FeiMaoUC"}',
    flagKeywords: ['UC', 'uc原画', '优视'],
  },
  {
    label: '阿里云盘',
    panType: 'aliyun',
    siteKey: 'csp_Duopan',
    api: 'csp_Duopan',
    ext: '{"site_urls":["http://tvpanpan.site","http://feimo.fun","http://xiaocgege.shop","http://www.xiaocgege.shop","https://www.xiaocge.fun"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"Duopan2"}',
    flagKeywords: ['阿里', 'aliyun', 'Aliyun'],
  },
  {
    label: '哔哩哔哩',
    panType: 'bili',
    siteKey: 'csp_Bili',
    api: 'csp_Bili',
    ext: '{"json":"https://nos.netease.com/ysf/0075389dca9afadd4614e9713765ff17.txt","cookie":""}',
    flagKeywords: ['B站', 'bili', 'bilibili', 'Bili'],
  },
];

module.exports = { SOURCES, PAN_TESTS };
