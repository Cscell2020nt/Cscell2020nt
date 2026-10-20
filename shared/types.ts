export type Role = 'admin' | 'seller';
export interface User { id: string; name: string; email: string; role: Role; sellerId?: string }
export interface Seller { id: string; name: string; initials: string; color: string; monthlyGoalCents: number; active: boolean }
export interface Financier { id: string; name: string }
export type SaleStatus = 'valid' | 'pending' | 'cancelled' | 'returned';
export interface SaleItem { product: string; category: string; quantity: number | null; netCents: number | null }
export interface Sale {
  id: string; externalId: string; date: string; time: string; sellerId: string;
  product: string; category: string; quantity: number; grossCents: number;
  discountCents: number; netCents: number; tradeInCents: number;
  financedCents: number; paymentMethod: string; financierId: string;
  customer?: string;
  commissionCategory?: 'accessories' | 'phones' | 'speakers';
  items?: SaleItem[];
  status: SaleStatus; fingerprint: string; batchId: string;
}
export interface ConsolidatedSummary {
  id: string; sellerId: string; startDate: string; endDate: string;
  revenueCents: number; salesCount: number; batchId: string;
}
export interface Settings {
  companyName: string; monthlyGoalCents: number; ticketGoalCents: number;
  goalsByMonth?: Record<string, { companyCents: number; sellerCents: Record<string, number> }>;
  workingDays: number[]; holidays: string[]; specialOpenDates: string[];
  reminderTime: string; timezone: string; alertThreshold: number;
}
export type ImportMode = 'daily' | 'cumulative' | 'summary';
export type ImportField = 'date' | 'time' | 'seller' | 'customer' | 'externalId' | 'product' | 'quantity' | 'category' | 'gross' | 'discount' | 'net' | 'tradeIn' | 'paymentMethod' | 'financier' | 'financed' | 'status' | 'salesCount';
export type ColumnMapping = Partial<Record<ImportField, string>>;
export interface ImportIssue { row: number; field: string; message: string }
export interface ImportOptions {
  mode?: ImportMode; mapping?: ColumnMapping; sellerAliases?: Record<string, string>;
  startDate?: string; endDate?: string; allowSummaryReplacement?: boolean;
}
export interface ParsedFile { columns: string[]; rows: Record<string, unknown>[]; warnings: string[] }
export interface NormalizedImport {
  sales: Sale[]; summaries: ConsolidatedSummary[]; issues: ImportIssue[];
  warnings: string[]; unresolvedSellers: string[]; mapping: ColumnMapping;
  periodStart: string; periodEnd: string; mode: ImportMode;
}
export interface ImportPreview extends NormalizedImport {
  id: string; filename: string; createdAt: string; columns: string[];
  newCount: number; duplicateCount: number; updateCount: number;
  revenueCents: number; salesCount: number; sellerNames: string[];
  hasOverlap: boolean;
}
export interface ImportBatch {
  id: string; filename: string; importedAt: string; userName: string;
  mode: ImportMode; periodStart: string; periodEnd: string;
  addedCount: number; updatedCount: number; ignoredCount: number;
  revenueCents: number; salesCount: number; status: 'confirmed' | 'reverted';
}
export interface AuditEntry { id: string; at: string; userName: string; action: string; details: string }
export interface Alert { id: string; date: string; type: string; message: string; read: boolean }
export interface AppData {
  sellers: Seller[]; financiers: Financier[]; sales: Sale[];
  summaries: ConsolidatedSummary[]; settings: Settings;
  batches: ImportBatch[]; audit: AuditEntry[]; alerts: Alert[];
}
export interface Period { from: string; to: string; asOf?: string }
export interface SellerMetric {
  seller: Seller; revenueCents: number; count: number; ticketCents: number;
  goalCents: number; percentage: number; remainingCents: number;
  neededDailyCents: number; rank: number;
}
export interface DayMetric { date: string; label: string; revenueCents: number; count: number; ticketCents: number; accumulatedCents: number; idealCents: number }
export interface FinanceMetric { financier: Financier; revenueCents: number; saleTotalCents: number; count: number; ticketCents: number; percentage: number }
export interface Analytics {
  revenueCents: number; count: number; ticketCents: number;
  goalCents: number; percentage: number; remainingCents: number;
  todayRevenueCents: number; dailyGoalCents: number; workingDays: number;
  elapsedDays: number; remainingDays: number; neededDailyCents: number;
  projectionCents: number; expectedCents: number; pace: 'above' | 'on-track' | 'below' | 'no-data';
  sellers: SellerMetric[]; days: DayMetric[]; financiers: FinanceMetric[];
  hasSummaries: boolean; warnings: string[];
}

export interface SellerReport { id: string; sellerId: string; startDate: string; endDate: string; filename: string; sizeBytes: number; uploadedAt: string; userName: string }
