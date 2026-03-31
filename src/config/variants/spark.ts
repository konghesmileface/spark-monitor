// Spark variant — Spark Finance embedded intelligence dashboard
// Full variant minus 3 panels: satellite-fires, oref-sirens, world-clock
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

export * from './base';

// Re-export geopolitical data (same as full)
export * from '../feeds';
export * from '../geo';
export * from '../irradiators';
export * from '../pipelines';
export * from '../ports';
export * from '../military';
export * from '../airports';
export * from '../entities';

// Bilingual panel titles for Spark variant
export const SPARK_PANEL_TITLES: Record<string, { zh: string; en: string }> = {
  map: { zh: '全球地图', en: 'Global Map' },
  'live-news': { zh: '实时新闻', en: 'Live News' },
  'live-webcams': { zh: '实时监控', en: 'Live Webcams' },
  'ai-overview': { zh: 'AI 分析', en: 'AI Analysis' },
  cii: { zh: '国家不稳定指数', en: 'Country Instability' },
  'strategic-risk': { zh: '战略风险概览', en: 'Strategic Risk' },
  intel: { zh: '情报动态', en: 'Intel Feed' },
  'gdelt-intel': { zh: '实时情报', en: 'Live Intelligence' },
  cascade: { zh: '基础设施级联', en: 'Infrastructure Cascade' },
  politics: { zh: '国际新闻', en: 'World News' },
  us: { zh: '美国', en: 'United States' },
  europe: { zh: '欧洲', en: 'Europe' },
  'regional-intel': { zh: '区域情报', en: 'Regional Intel' },
  middleeast: { zh: '中东', en: 'Middle East' },
  africa: { zh: '非洲', en: 'Africa' },
  latam: { zh: '拉丁美洲', en: 'Latin America' },
  asia: { zh: '亚太', en: 'Asia-Pacific' },
  energy: { zh: '能源与资源', en: 'Energy & Resources' },
  gov: { zh: '政府', en: 'Government' },
  thinktanks: { zh: '智库', en: 'Think Tanks' },
  polymarket: { zh: '预测市场', en: 'Predictions' },
  'market-overview': { zh: '市场概览', en: 'Market Overview' },
  commodities: { zh: '大宗商品', en: 'Commodities' },
  markets: { zh: '金融市场', en: 'Markets' },
  economic: { zh: '经济指标', en: 'Economic Indicators' },
  'trade-policy': { zh: '贸易政策', en: 'Trade Policy' },
  'supply-chain': { zh: '供应链', en: 'Supply Chain' },
  finance: { zh: '财经', en: 'Financial' },
  tech: { zh: '科技', en: 'Technology' },
  crypto: { zh: '加密货币', en: 'Crypto' },
  'crypto-overview': { zh: '数字资产', en: 'Digital Assets' },
  heatmap: { zh: '板块热力图', en: 'Sector Heatmap' },
  ai: { zh: '人工智能', en: 'AI/ML' },
  layoffs: { zh: '裁员追踪', en: 'Layoffs Tracker' },
  'macro-signals': { zh: '市场雷达', en: 'Market Radar' },
  'gulf-economies': { zh: '海湾经济', en: 'Gulf Economies' },
  'etf-flows': { zh: 'BTC ETF', en: 'BTC ETF Tracker' },
  stablecoins: { zh: '稳定币', en: 'Stablecoins' },
  'ucdp-events': { zh: '冲突事件', en: 'UCDP Conflicts' },
  displacement: { zh: '难民流离', en: 'UNHCR Displacement' },
  climate: { zh: '气候异常', en: 'Climate Anomalies' },
  'population-exposure': { zh: '人口暴露', en: 'Population Exposure' },
  'security-advisories': { zh: '安全通告', en: 'Security Advisories' },
  'intel-overview': { zh: '情报概览', en: 'Intel Overview' },
};

// Panel configuration — Full minus satellite-fires, oref-sirens, world-clock
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  'live-news': { name: 'Live News', enabled: true, priority: 1 },
  'ai-overview': { name: 'AI Analysis', enabled: true, priority: 1 },
  'live-webcams': { name: 'Live Webcams', enabled: true, priority: 1 },
  // cii: merged into strategic-risk panel
  'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1 },
  'crypto-overview': { name: 'Digital Assets', enabled: true, priority: 1 },
  'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 1 },
  // cascade: merged into strategic-risk panel
  politics: { name: 'World News', enabled: true, priority: 1 },
  // us + europe: merged into regional-intel TabbedNewsPanel
  'regional-intel': { name: 'Regional Intel', enabled: true, priority: 1 },
  polymarket: { name: 'Predictions', enabled: true, priority: 1 },
  'intel-overview': { name: 'Intel Overview', enabled: true, priority: 1 },
  markets: { name: 'Markets', enabled: true, priority: 1 },
  economic: { name: 'Economic Indicators', enabled: true, priority: 1 },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
  'supply-chain': { name: 'Supply Chain', enabled: true, priority: 1 },
  finance: { name: 'Financial', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: true, priority: 2 },
  intel: { name: 'Intel Feed', enabled: true, priority: 2 },
  ai: { name: 'AI/ML', enabled: true, priority: 2 },
  layoffs: { name: 'Layoffs Tracker', enabled: true, priority: 2 },
  // monitors REMOVED from spark variant
  // satellite-fires REMOVED
  // macro-signals: now embedded in crypto-overview as 4th tab
  'gulf-economies': { name: 'Gulf Economies', enabled: false, priority: 2 },
  // etf-flows + stablecoins + crypto merged into crypto-overview
  'ucdp-events': { name: 'UCDP Conflict Events', enabled: true, priority: 2 },
  giving: { name: 'Global Giving', enabled: false, priority: 2 },
  displacement: { name: 'UNHCR Displacement', enabled: false, priority: 2 },
  // climate REMOVED from spark variant
  'population-exposure': { name: 'Population Exposure', enabled: true, priority: 2 },
  // security-advisories: now embedded in intel-overview as 3rd tab
  // oref-sirens REMOVED
  'market-overview': { name: 'Market Overview', enabled: true, priority: 2 },
  // world-clock REMOVED
};

// Map layers — same as full
export const DEFAULT_MAP_LAYERS: MapLayers = {
  iranAttacks: true,
  gpsJamming: true,
  conflicts: true,
  bases: true,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: true,
  nuclear: true,
  irradiators: false,
  sanctions: true,
  weather: true,
  economic: true,
  waterways: true,
  outages: true,
  cyberThreats: true,
  datacenters: false,
  protests: true,
  flights: false,
  military: true,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: true,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  dayNight: false,
};

export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  iranAttacks: true,
  gpsJamming: false,
  conflicts: true,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: true,
  weather: true,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: true,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: true,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  dayNight: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'spark',
  description: 'Spark Finance global intelligence dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
