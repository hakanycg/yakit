import { db } from "../db/index.js";
import type { InvoiceRow, UserRow } from "../db/types.js";

export function getInvoiceForTransaction(transactionId: number): InvoiceRow | undefined {
  return db.prepare<[number], InvoiceRow>("SELECT * FROM invoices WHERE transaction_id = ?").get(transactionId);
}

export function recordInvoiceSuccess(stationId: number, transactionId: number, providerInvoiceId: string, actor: UserRow): InvoiceRow {
  db.prepare(
    `INSERT INTO invoices (station_id, transaction_id, status, provider_invoice_id, created_by) VALUES (?, ?, 'sent', ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET status = 'sent', provider_invoice_id = excluded.provider_invoice_id, error_message = NULL, created_by = excluded.created_by, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(stationId, transactionId, providerInvoiceId, actor.id);
  return getInvoiceForTransaction(transactionId)!;
}

export function recordInvoiceFailure(stationId: number, transactionId: number, errorMessage: string, actor: UserRow): InvoiceRow {
  db.prepare(
    `INSERT INTO invoices (station_id, transaction_id, status, error_message, created_by) VALUES (?, ?, 'failed', ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET status = 'failed', error_message = excluded.error_message, created_by = excluded.created_by, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(stationId, transactionId, errorMessage, actor.id);
  return getInvoiceForTransaction(transactionId)!;
}

export function serializeInvoice(i: InvoiceRow) {
  return {
    status: i.status,
    providerInvoiceId: i.provider_invoice_id,
    errorMessage: i.error_message,
    createdAt: i.created_at,
  };
}
