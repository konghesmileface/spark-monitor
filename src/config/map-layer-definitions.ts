import type { MapLayers } from '@/types';

export type MapRenderer = 'flat' | 'globe';
export type MapVariant = 'full' | 'tech' | 'finance' | 'happy';

export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  renderers: MapRenderer[];
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: MapRenderer[] = ['flat', 'globe'],
): LayerDefinition => ({ key, icon, i18nSuffix, fallbackLabel, renderers });

export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  iranAttacks:              def('iranAttacks',              '<i class="bi bi-bullseye"></i>', 'iranAttacks',              'Iran Attacks'),
  hotspots:                 def('hotspots',                 '<i class="bi bi-bullseye"></i>', 'intelHotspots',            'Intel Hotspots'),
  conflicts:                def('conflicts',                '<i class="bi bi-crosshair"></i>', 'conflictZones',            'Conflict Zones'),

  bases:                    def('bases',                    '<i class="bi bi-bank"></i>', 'militaryBases',            'Military Bases'),
  nuclear:                  def('nuclear',                  '<i class="bi bi-radioactive"></i>', 'nuclearSites',             'Nuclear Sites'),
  irradiators:              def('irradiators',              '<i class="bi bi-exclamation-triangle-fill"></i>', 'gammaIrradiators',         'Gamma Irradiators'),
  spaceports:               def('spaceports',               '<i class="bi bi-rocket-takeoff"></i>', 'spaceports',               'Spaceports'),
  cables:                   def('cables',                   '<i class="bi bi-link-45deg"></i>', 'underseaCables',           'Undersea Cables'),
  pipelines:                def('pipelines',                '<i class="bi bi-fuel-pump"></i>', 'pipelines',                'Pipelines'),
  datacenters:              def('datacenters',              '<i class="bi bi-pc-display"></i>', 'aiDataCenters',            'AI Data Centers'),
  military:                 def('military',                 '<i class="bi bi-airplane-fill"></i>', 'militaryActivity',         'Military Activity'),
  ais:                      def('ais',                      '<i class="bi bi-water"></i>', 'shipTraffic',              'Ship Traffic'),
  tradeRoutes:              def('tradeRoutes',              '<i class="bi bi-signpost-split"></i>', 'tradeRoutes',              'Trade Routes'),
  flights:                  def('flights',                  '<i class="bi bi-airplane"></i>', 'flightDelays',             'Flight Delays'),
  protests:                 def('protests',                 '<i class="bi bi-megaphone-fill"></i>', 'protests',                 'Protests'),
  ucdpEvents:               def('ucdpEvents',               '<i class="bi bi-crosshair"></i>', 'ucdpEvents',               'Armed Conflict Events'),
  displacement:             def('displacement',             '<i class="bi bi-people-fill"></i>', 'displacementFlows',        'Displacement Flows'),
  climate:                  def('climate',                  '<i class="bi bi-thermometer-half"></i>', 'climateAnomalies',         'Climate Anomalies'),
  weather:                  def('weather',                  '<i class="bi bi-cloud-lightning-fill"></i>', 'weatherAlerts',            'Weather Alerts'),
  outages:                  def('outages',                  '<i class="bi bi-broadcast"></i>', 'internetOutages',          'Internet Outages'),
  cyberThreats:             def('cyberThreats',             '<i class="bi bi-shield-check"></i>', 'cyberThreats',             'Cyber Threats'),
  natural:                  def('natural',                  '<i class="bi bi-globe2"></i>', 'naturalEvents',            'Natural Events'),
  fires:                    def('fires',                    '<i class="bi bi-fire"></i>', 'fires',                    'Fires'),
  waterways:                def('waterways',                '<i class="bi bi-signpost-split"></i>', 'strategicWaterways',       'Strategic Waterways'),
  economic:                 def('economic',                 '<i class="bi bi-cash-stack"></i>', 'economicCenters',          'Economic Centers'),
  minerals:                 def('minerals',                 '<i class="bi bi-gem"></i>', 'criticalMinerals',         'Critical Minerals'),
  gpsJamming:               def('gpsJamming',               '<i class="bi bi-broadcast-pin"></i>', 'gpsJamming',               'GPS Jamming'),
  ciiChoropleth:            def('ciiChoropleth',            '<i class="bi bi-globe"></i>', 'ciiChoropleth',            'CII Instability'),
  dayNight:                 def('dayNight',                 '<i class="bi bi-moon-fill"></i>', 'dayNight',                 'Day/Night', ['flat']),
  sanctions:                def('sanctions',                '<i class="bi bi-slash-circle"></i>', 'sanctions',                'Sanctions', []),
  startupHubs:              def('startupHubs',              '<i class="bi bi-rocket-takeoff"></i>', 'startupHubs',              'Startup Hubs'),
  techHQs:                  def('techHQs',                  '<i class="bi bi-building"></i>', 'techHQs',                  'Tech HQs'),
  accelerators:             def('accelerators',             '<i class="bi bi-lightning-charge-fill"></i>', 'accelerators',             'Accelerators'),
  cloudRegions:             def('cloudRegions',             '<i class="bi bi-cloud-fill"></i>', 'cloudRegions',             'Cloud Regions'),
  techEvents:               def('techEvents',               '<i class="bi bi-calendar-event"></i>', 'techEvents',               'Tech Events'),
  stockExchanges:           def('stockExchanges',           '<i class="bi bi-bank"></i>', 'stockExchanges',           'Stock Exchanges'),
  financialCenters:         def('financialCenters',         '<i class="bi bi-cash-stack"></i>', 'financialCenters',         'Financial Centers'),
  centralBanks:             def('centralBanks',             '<i class="bi bi-bank2"></i>', 'centralBanks',             'Central Banks'),
  commodityHubs:            def('commodityHubs',            '<i class="bi bi-box-seam"></i>', 'commodityHubs',            'Commodity Hubs'),
  gulfInvestments:          def('gulfInvestments',          '<i class="bi bi-globe"></i>', 'gulfInvestments',          'GCC Investments'),
  positiveEvents:           def('positiveEvents',           '<i class="bi bi-stars"></i>', 'positiveEvents',           'Positive Events'),
  kindness:                 def('kindness',                 '<i class="bi bi-heart-fill"></i>', 'kindness',                 'Acts of Kindness'),
  happiness:                def('happiness',                '<i class="bi bi-emoji-smile"></i>', 'happiness',                'World Happiness'),
  speciesRecovery:          def('speciesRecovery',          '<i class="bi bi-tree-fill"></i>', 'speciesRecovery',          'Species Recovery'),
  renewableInstallations:   def('renewableInstallations',   '<i class="bi bi-lightning-charge-fill"></i>', 'renewableInstallations',   'Clean Energy'),
};

const VARIANT_LAYER_ORDER: Record<MapVariant, Array<keyof MapLayers>> = {
  full: [
    'iranAttacks', 'hotspots', 'conflicts',
    'bases', 'nuclear', 'irradiators', 'spaceports',
    'cables', 'pipelines', 'datacenters', 'military',
    'ais', 'tradeRoutes', 'flights', 'protests',
    'ucdpEvents', 'displacement', 'climate', 'weather',
    'outages', 'cyberThreats', 'natural', 'fires',
    'waterways', 'economic', 'minerals', 'gpsJamming',
    'ciiChoropleth', 'dayNight',
  ],
  tech: [
    'startupHubs', 'techHQs', 'accelerators', 'cloudRegions',
    'datacenters', 'cables', 'outages', 'cyberThreats',
    'techEvents', 'natural', 'fires', 'dayNight',
  ],
  finance: [
    'stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs',
    'gulfInvestments', 'tradeRoutes', 'cables', 'pipelines',
    'outages', 'weather', 'economic', 'waterways',
    'natural', 'cyberThreats', 'dayNight',
  ],
  happy: [
    'positiveEvents', 'kindness', 'happiness',
    'speciesRecovery', 'renewableInstallations',
  ],
};

const I18N_PREFIX = 'components.deckgl.layers.';

export function getLayersForVariant(variant: MapVariant, renderer: MapRenderer): LayerDefinition[] {
  const keys = VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full;
  return keys
    .map(k => LAYER_REGISTRY[k])
    .filter(d => d.renderers.includes(renderer));
}

export function resolveLayerLabel(def: LayerDefinition, tFn?: (key: string) => string): string {
  if (tFn) {
    const translated = tFn(I18N_PREFIX + def.i18nSuffix);
    if (translated && translated !== I18N_PREFIX + def.i18nSuffix) return translated;
  }
  return def.fallbackLabel;
}
