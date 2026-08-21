export type RoleName = "super_admin" | "admin" | "operator" | "viewer";
export type FuelType = "benzin" | "motorin" | "lpg";
export type PumpStatus = "idle" | "reserved" | "dispensing" | "fault" | "offline";
export type TransactionStatus =
  | "created"
  | "paid"
  | "authorized"
  | "dispensing"
  | "completed"
  | "cancelled"
  | "failed";

export interface CurrentUser {
  id: number;
  username: string;
  displayName: string;
  role: RoleName;
  stationId: number | null;
  mustChangePassword: boolean;
  email: string | null;
  phone: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
  totpEnabled: boolean;
}

export interface Pump {
  id: number;
  stationId: number;
  number: number;
  label: string;
  status: PumpStatus;
  fuelTypes: FuelType[];
  posX: number;
  posY: number;
  faultCode: string | null;
  faultMessage: string | null;
  currentTransactionId: number | null;
  updatedAt: string;
}

export interface Transaction {
  id: number;
  stationId: number;
  pumpId: number;
  plate: string;
  plateSource: "manual" | "lpr";
  fuelType: FuelType;
  amountMode: "amount" | "liters" | "full_tank";
  requestedAmount: number | null;
  requestedLiters: number | null;
  pricePerLiter: number;
  dispensedLiters: number;
  totalAmount: number;
  discountCode: string | null;
  discountAmount: number;
  loyaltyPointsRedeemed: number;
  loyaltyPointsEarned: number;
  chargeAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  status: TransactionStatus;
  startedAt: string | null;
  completedAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Alarm {
  id: number;
  stationId: number;
  pumpId: number | null;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  status: "active" | "acknowledged" | "resolved";
  acknowledgedBy: number | null;
  acknowledgedAt: string | null;
  resolvedBy: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface FuelPrice {
  fuelType: FuelType;
  label: string;
  pricePerLiter: number;
  updatedAt?: string;
  inStock?: boolean;
}

export type TankStatus = "ok" | "low" | "critical";

export interface FuelTank {
  fuelType: FuelType;
  capacityLiters: number;
  currentLiters: number;
  lowStockThresholdLiters: number;
  averageCostPerLiter: number;
  percentFull: number;
  status: TankStatus;
  updatedAt: string;
}

export type FuelStockMovementType = "delivery" | "sale" | "adjustment";

export interface FuelStockMovement {
  id: number;
  fuelType: FuelType;
  type: FuelStockMovementType;
  liters: number;
  balanceAfter: number;
  supplier: string | null;
  deliveryRef: string | null;
  note: string | null;
  unitCost: number | null;
  transactionId: number | null;
  username: string | null;
  createdAt: string;
}

export interface SupplierSummaryRow {
  supplier: string;
  fuelType: FuelType;
  deliveryCount: number;
  totalLiters: number;
  avgUnitCost: number | null;
  lastDeliveryAt: string;
}

export interface Station {
  id: number;
  slug: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active?: boolean;
  createdAt?: string;
  pumpCount?: number;
  transactionCount?: number;
  activeAlarms?: number;
  userCount?: number;
  lastHeartbeatAt?: string | null;
  lastSyncedAt?: string | null;
  agentConfigured?: boolean;
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: RoleName;
  stationId: number | null;
  stationName: string | null;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  locked: boolean;
  email: string | null;
  phone: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
}

export interface AuditEntry {
  id: number;
  stationId: number | null;
  userId: number | null;
  username: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ipAddress: string | null;
  createdAt: string;
}
