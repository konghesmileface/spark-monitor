export interface GovNewsItem {
  title: string;
  url: string;
  date: string;
  source: string;
  source_key?: string;
  category: string;
  icon: string;
  crawled_at?: string;
  via_search?: boolean;
}

export interface GovNewsData {
  categories: Record<string, GovNewsItem[]>;
  all: GovNewsItem[];
  sources: Record<string, number>;
  total: number;
  category_list: string[];
  timestamp: string;
}

export interface PolicyStats {
  total: number;
  today_count: number;
  earliest_date: string | null;
  latest_date: string | null;
  sources: Record<string, { name: string; count: number }>;
  categories: Record<string, number>;
  date_summary: { date: string; count: number }[];
  source_list: Record<string, string>;
  category_list: string[];
}

export interface MorningBriefData {
  status?: string;
  message?: string;
  ceo_one_liner?: string;
  ceo_key_angles?: { angle: string; insight: string; detail?: string; metric?: string }[];
  headline_alert?: string;
  key_number?: string;
  situation_delta?: string;
  executive_summary: string | { situation?: string; impact?: string; direction?: string };
  risk_score: number;
  risk_trend: 'improving' | 'stable' | 'deteriorating' | 'rising' | 'falling';
  opportunities: {
    title: string; description?: string; analysis?: string; action: string;
    source?: string; impact_score?: number; impact_dimension?: string;
    estimated_effect?: string; urgency: string;
    confidence?: string; time_window?: string;
    potential?: string; deadline?: string; source_policy?: string;
    transmission_chain?: string[];
  }[];
  risks: {
    title: string; description?: string; analysis?: string; mitigation: string;
    source?: string; impact_score?: number; impact_dimension?: string;
    estimated_loss?: string; probability?: string; urgency?: string;
    velocity?: string; early_warning?: string;
    severity?: string; timeline?: string; source_policy?: string;
    transmission_chain?: string[];
  }[];
  action_items: {
    action: string; priority: string | number; deadline_hint?: string;
    related_risk_or_opp?: string; owner?: string; deadline?: string;
  }[];
  competitive_landscape: {
    summary: string;
    market_concentration?: string;
    competitors: { name: string; impact: string; your_advantage: string; threat_level?: string }[];
    recent_moves?: string[];
    new_entrants?: string | null;
    substitutes?: string | null;
  };
  industry_direction: {
    trend: string; trend_label: string; summary: string; key_indicator: string;
    capacity_cycle?: string; tech_roadmap?: string;
    demand_outlook?: string; regulatory_trend?: string;
  };
  global_impact?: string | {
    summary?: string; trade_relations?: string; forex_commodities?: string;
    geopolitical?: string | null; supply_chain_shifts?: string | null;
    prediction_markets?: string | null;
  };
  executive_perspectives?: Array<{role: string; role_label: string; focus: string; near_term: string; mid_term: string; long_term: string}>;
  macro_snapshot?: {
    economy_phase?: string; policy_stance?: string; key_indicators?: string;
    fiscal_highlight?: string; monetary_highlight?: string;
  };
  regional_insight?: string;
  generated_at: string;
  policy_count: number;
  alert_count: number;
  ai_unavailable?: boolean;
}

export interface IndustryDevelopment {
  title: string;
  source: string;
  date: string;
  urgency: 'urgent' | 'important' | 'watch';
  urgency_label: string;
  impact_summary: string;
  business_impact?: string;
  action_deadline?: string;
  recommended_actions: string[];
  affected_areas: string[];
}

export interface IndustryBrief {
  status?: string;
  message?: string;
  headline: string;
  risk_level: string;
  risk_label: string;
  industry_health_score?: number;
  industry_health_label?: string;
  industries: string[];
  key_developments: IndustryDevelopment[];
  trend_signals?: { signal: string; direction: string; strength: number }[];
  outlook: { summary: string; timeframe: string; key_dates: string[] };
  next_week_watchlist?: string[];
  risks: { description: string; severity: string; category: string }[];
  opportunities: { description: string; potential: string; category: string }[];
  policy_count: number;
  total_policy_count?: number;
  generated_at: string;
  fallback?: boolean;
  ai_unavailable?: boolean;
  loose_match?: boolean;
  international_context?: string;
  supply_chain_map?: { upstream: string; midstream: string; downstream: string };
  executive_lens?: Record<string, string>;
  time_horizon?: Record<string, string>;
}

export interface CompetitorNewsItem {
  title: string;
  source: string;
  date: string;
}

export interface CompetitorItem {
  name: string;
  is_listed: boolean;
  stock_code?: string;
  stock_price?: number;
  stock_change_pct?: number;
  web_news: CompetitorNewsItem[];
  db_news: CompetitorNewsItem[];
}

export interface CompetitorAnalysisItem {
  name: string;
  threat_level: 'high' | 'medium' | 'low';
  urgency: 'immediate' | 'watch' | 'none';
  impact: string;
  opportunities: string[];
  risks: string[];
}

export interface CompetitorActionItem {
  action: string;
  urgency: 'immediate' | 'this_week' | 'watch';
}

export interface CompetitorAnalysis {
  pressure_score: number;
  pressure_trend: 'rising' | 'stable' | 'easing';
  summary: string;
  action_items: CompetitorActionItem[];
  supply_chain_risks: string[];
  competitors: CompetitorAnalysisItem[];
}

export interface CompetitorIntelData {
  status?: string;
  message?: string;
  competitors: CompetitorItem[];
  analysis?: CompetitorAnalysis;
  formatted_text: string;
  generated_at: string;
}
