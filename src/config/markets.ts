import type { Sector, Commodity, MarketSymbol } from '@/types';

export const SECTORS: Sector[] = [
  { symbol: 'XLK', name: 'Tech' },
  { symbol: 'XLF', name: 'Finance' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLV', name: 'Health' },
  { symbol: 'XLY', name: 'Consumer' },
  { symbol: 'XLI', name: 'Industrial' },
  { symbol: 'XLP', name: 'Staples' },
  { symbol: 'XLU', name: 'Utilities' },
  { symbol: 'XLB', name: 'Materials' },
  { symbol: 'XLRE', name: 'Real Est' },
  { symbol: 'XLC', name: 'Comms' },
  { symbol: 'SMH', name: 'Semis' },
];

export const COMMODITIES: Commodity[] = [
  { symbol: '^VIX', name: 'VIX', display: 'VIX' },
  { symbol: 'GC=F', name: 'Gold', display: 'GOLD' },
  { symbol: 'CL=F', name: 'Crude Oil', display: 'OIL' },
  { symbol: 'NG=F', name: 'Natural Gas', display: 'NATGAS' },
  { symbol: 'SI=F', name: 'Silver', display: 'SILVER' },
  { symbol: 'HG=F', name: 'Copper', display: 'COPPER' },
];

/** Expanded commodities for Spark variant — fills the panel */
export const SPARK_COMMODITIES: Commodity[] = [
  ...COMMODITIES,
  { symbol: 'PL=F', name: 'Platinum', display: 'PLAT' },
  { symbol: 'PA=F', name: 'Palladium', display: 'PALLAD' },
  { symbol: 'ZW=F', name: 'Wheat', display: 'WHEAT' },
  { symbol: 'ZC=F', name: 'Corn', display: 'CORN' },
  { symbol: 'ZS=F', name: 'Soybeans', display: 'SOYBN' },
  { symbol: 'CT=F', name: 'Cotton', display: 'COTTON' },
  { symbol: 'KC=F', name: 'Coffee', display: 'COFFEE' },
  { symbol: 'SB=F', name: 'Sugar', display: 'SUGAR' },
  { symbol: 'DX-Y.NYB', name: 'US Dollar', display: 'DXY' },
  { symbol: '^TNX', name: '10Y Treasury', display: '10Y UST' },
  // Asian indices & forex for KPI bar
  { symbol: 'CNY=X', name: 'USD/CNY', display: 'USD/CNY' },
  { symbol: '^HSI', name: 'Hang Seng', display: 'HSI' },
  { symbol: '000001.SS', name: 'SSE Composite', display: '上证' },
  { symbol: '399001.SZ', name: 'SZSE Component', display: '深证' },
  { symbol: '399006.SZ', name: 'ChiNext', display: '创业板' },
  { symbol: '000300.SS', name: 'CSI 300', display: '沪深300' },
];

/** Expanded sectors for Spark heatmap — sub-industries for richer view */
export const SPARK_SECTORS: Sector[] = [
  // Core S&P sectors
  ...SECTORS,
  // Sub-sector / industry ETFs
  { symbol: 'XBI', name: 'Biotech' },
  { symbol: 'XHB', name: 'Homebuild' },
  { symbol: 'XOP', name: 'Oil Expl' },
  { symbol: 'XME', name: 'Metals' },
  { symbol: 'KRE', name: 'Reg Banks' },
  { symbol: 'XRT', name: 'Retail' },
  { symbol: 'IYT', name: 'Transport' },
  { symbol: 'ITB', name: 'Construct' },
  { symbol: 'HACK', name: 'Cyber' },
  { symbol: 'SOXX', name: 'Semis+' },
  { symbol: 'IBB', name: 'Biotech+' },
  { symbol: 'IYR', name: 'REIT' },
  { symbol: 'TAN', name: 'Solar' },
  { symbol: 'ARKK', name: 'Innov' },
  { symbol: 'GDX', name: 'Gold Min' },
  { symbol: 'XAR', name: 'Aero Def' },
  { symbol: 'IHI', name: 'Med Dev' },
  { symbol: 'IGV', name: 'Software' },
  { symbol: 'KWEB', name: 'CN Tech' },
  { symbol: 'EWJ', name: 'Japan' },
];

export const MARKET_SYMBOLS: MarketSymbol[] = [
  { symbol: '^GSPC', name: 'S&P 500', display: 'SPX' },
  { symbol: '^DJI', name: 'Dow Jones', display: 'DOW' },
  { symbol: '^IXIC', name: 'NASDAQ', display: 'NDX' },
  { symbol: 'AAPL', name: 'Apple', display: 'AAPL' },
  { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT' },
  { symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA' },
  { symbol: 'GOOGL', name: 'Alphabet', display: 'GOOGL' },
  { symbol: 'AMZN', name: 'Amazon', display: 'AMZN' },
  { symbol: 'META', name: 'Meta', display: 'META' },
  { symbol: 'BRK-B', name: 'Berkshire', display: 'BRK.B' },
  { symbol: 'TSM', name: 'TSMC', display: 'TSM' },
  { symbol: 'LLY', name: 'Eli Lilly', display: 'LLY' },
  { symbol: 'TSLA', name: 'Tesla', display: 'TSLA' },
  { symbol: 'AVGO', name: 'Broadcom', display: 'AVGO' },
  { symbol: 'WMT', name: 'Walmart', display: 'WMT' },
  { symbol: 'JPM', name: 'JPMorgan', display: 'JPM' },
  { symbol: 'V', name: 'Visa', display: 'V' },
  { symbol: 'UNH', name: 'UnitedHealth', display: 'UNH' },
  { symbol: 'NVO', name: 'Novo Nordisk', display: 'NVO' },
  { symbol: 'XOM', name: 'Exxon', display: 'XOM' },
  { symbol: 'MA', name: 'Mastercard', display: 'MA' },
  { symbol: 'ORCL', name: 'Oracle', display: 'ORCL' },
  { symbol: 'PG', name: 'P&G', display: 'PG' },
  { symbol: 'COST', name: 'Costco', display: 'COST' },
  { symbol: 'JNJ', name: 'J&J', display: 'JNJ' },
  { symbol: 'HD', name: 'Home Depot', display: 'HD' },
  { symbol: 'NFLX', name: 'Netflix', display: 'NFLX' },
  { symbol: 'BAC', name: 'BofA', display: 'BAC' },
];

export const CRYPTO_IDS = ['bitcoin', 'ethereum', 'solana', 'ripple'] as const;

export const CRYPTO_MAP: Record<string, { name: string; symbol: string }> = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
  ripple: { name: 'XRP', symbol: 'XRP' },
};
