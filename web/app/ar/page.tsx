"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createArRecord,
  deleteArRecord,
  fetchArOverview,
  fetchPoWorkOptions,
  recordArPayment,
  updateArRecord,
} from "@/lib/api";
import type { ArData, ArRow, PoWorkOptions } from "@/lib/types";
import AppShell, { SectionHead } from "@/components/AppShell";

const today = () => new Date().toISOString().slice(0, 10);

type ArForm = {
  id: number;
  order_id: number | "";
  ci_no: string;
  invoice_amount: number;
  paid_amount: number;
  currency: string;
  due_date: string;
  status: string;
  notes: string;
};

const emptyForm: ArForm = {
  id: 0,
  order_id: "",
  ci_no: "",
  invoice_amount: 0,
  paid_amount: 0,
  currency: "USD",
  due_date: today(),
  status: "미수",
  notes: "",
};

export default function ArPage() {
  return (
    <AppShell active="ar">
      <ArOverview />
    </AppShell>
  );
}

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ArOverview() {
  const [data, setData] = useState<ArData | null>(null);
  const [options, setOptions] = useState<PoWorkOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("전체");
  const [currency, setCurrency] = useState("전체");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  function load() {
    setError(null);
    fetchArOverview()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
    fetchPoWorkOptions().then(setOptions).catch(() => setOptions(null));
  }

  useEffect(load, []);

  const statuses = useMemo(() => (data ? Array.from(new Set(data.rows.map((r) => r.status))) : []), [data]);
  const currencies = useMemo(() => (data ? Array.from(new Set(data.rows.map((r) => r.currency))) : []), [data]);
  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) => (status === "전체" || r.status === status) && (currency === "전체" || r.currency === currency)
      ),
    [data, status, currency]
  );
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const kpi = useMemo(() => {
    let out = 0;
    let over = 0;
    for (const r of rows) {
      if (r.currency === "USD") {
        out += r.outstanding;
        if (r.overdue) over += r.outstanding;
      }
    }
    return { outstanding_usd: out, overdue_usd: over, count: rows.length };
  }, [rows]);

  return (
    <>
      <SectionHead title="AR 관리" sub="Accounts Receivable / SOA · 청구 · 수금 · 연체" />

      {error ? <div className="state error">API 오류: {error}</div> : null}
      {!data ? (
        <div className="state">불러오는 중...</div>
      ) : (
        <>
          <div className="toolbar">
            <div className="field">
              <label>상태 필터</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="전체">전체</option>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label>통화 필터</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="전체">전체</option>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button className="btn" onClick={load}>새로고침</button>
          </div>

          <div className="kpi-row">
            <Kpi label="USD 미수금" value={`USD ${money(kpi.outstanding_usd)}`} sub="필터 기준 미수 합계" />
            <Kpi label="USD 연체" value={`USD ${money(kpi.overdue_usd)}`} sub="만기 경과" accent="#dc3545" />
            <Kpi label="건수" value={kpi.count} sub="AR 레코드" />
          </div>

          {rows.length === 0 ? (
            <div className="state">AR 레코드가 없습니다. Tax Invoice 생성 시 자동 등록되거나 아래에서 직접 추가할 수 있습니다.</div>
          ) : (
            <div className="table-wrap">
              <table className="rfq">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}></th>
                    <th>CI No.</th>
                    <th>Customer</th>
                    <th>오더</th>
                    <th>통화</th>
                    <th className="num">Invoice</th>
                    <th className="num">수금</th>
                    <th className="num">미수금</th>
                    <th>만기일</th>
                    <th>상태</th>
                    <th>수금 등록</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <ArRowView
                      key={r.id}
                      r={r}
                      selected={r.id === selectedId}
                      onSelect={() => setSelectedId(r.id === selectedId ? null : r.id)}
                      onPaid={load}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ArEditPanel selected={selected} options={options} onChanged={load} clearSelection={() => setSelectedId(null)} />
        </>
      )}
    </>
  );
}

function ArRowView({
  r,
  selected,
  onSelect,
  onPaid,
}: {
  r: ArRow;
  selected: boolean;
  onSelect: () => void;
  onPaid: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    if (amount === "") return;
    setBusy(true);
    setErr(null);
    try {
      await recordArPayment(r.id, Number(amount));
      setAmount("");
      onPaid();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "수금 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={selected ? "sel" : ""} onClick={onSelect}>
      <td className="select-cell">
        <input type="checkbox" checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} />
      </td>
      <td className="cell">{r.ci_no || <span className="dash">-</span>}</td>
      <td className="cell">{r.customer}</td>
      <td className="cell">{r.ord_no || <span className="dash">-</span>}</td>
      <td className="cell">{r.currency}</td>
      <td className="cell num">{money(r.invoice_amount)}</td>
      <td className="cell num">{money(r.paid_amount)}</td>
      <td className="cell num"><b>{money(r.outstanding)}</b></td>
      <td className="cell">{r.due_date || "-"}</td>
      <td className="cell"><span className={`ar-badge${r.overdue ? " overdue" : ""}`}>{r.status}</span></td>
      <td className="cell" onClick={(e) => e.stopPropagation()}>
        {r.outstanding <= 0 ? (
          <span className="dash">-</span>
        ) : (
          <span className="pay-cell">
            <input
              className="action-input num"
              placeholder="수금액"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <button className="btn primary" onClick={pay} disabled={busy || amount === ""}>
              {busy ? "..." : "등록"}
            </button>
            {err ? <span className="action-err">{err}</span> : null}
          </span>
        )}
      </td>
    </tr>
  );
}

function ArEditPanel({
  selected,
  options,
  onChanged,
  clearSelection,
}: {
  selected: ArRow | null;
  options: PoWorkOptions | null;
  onChanged: () => void;
  clearSelection: () => void;
}) {
  const [form, setForm] = useState<ArForm>(emptyForm);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (selected) {
      setForm({
        id: selected.id,
        order_id: selected.order_id,
        ci_no: selected.ci_no,
        invoice_amount: selected.invoice_amount,
        paid_amount: selected.paid_amount,
        currency: selected.currency,
        due_date: selected.due_date || today(),
        status: selected.status,
        notes: selected.notes,
      });
    } else {
      setForm(emptyForm);
    }
  }, [selected]);

  async function save() {
    if (form.order_id === "") return;
    setErr("");
    const body = {
      order_id: form.order_id,
      ci_no: form.ci_no,
      invoice_amount: form.invoice_amount,
      paid_amount: form.paid_amount,
      currency: form.currency,
      due_date: form.due_date,
      status: form.status,
      notes: form.notes,
    };
    try {
      if (form.id) await updateArRecord(form.id, body);
      else await createArRecord(body);
      setForm(emptyForm);
      clearSelection();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function remove() {
    if (!form.id || !confirm("선택한 AR 레코드를 삭제할까요?")) return;
    setErr("");
    try {
      await deleteArRecord(form.id);
      setForm(emptyForm);
      clearSelection();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  return (
    <div className="action-tabs">
      <h3>{form.id ? `${form.ci_no || "AR"} 수정` : "직접 AR 레코드 추가"}</h3>
      <div className="form-grid">
        <label className="form-field">
          <span>오더 *</span>
          <select
            value={form.order_id}
            onChange={(e) => setForm({ ...form, order_id: e.target.value ? Number(e.target.value) : "" })}
          >
            <option value="">선택</option>
            {(options?.orders || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.ord_no} · {o.customer} · {o.vessel || "-"}
              </option>
            ))}
          </select>
        </label>
        <Field label="CI No." value={form.ci_no} onChange={(v) => setForm({ ...form, ci_no: v })} />
        <Field label="Invoice 금액" value={String(form.invoice_amount)} onChange={(v) => setForm({ ...form, invoice_amount: num(v) })} type="number" />
        <Field label="수금액" value={String(form.paid_amount)} onChange={(v) => setForm({ ...form, paid_amount: num(v) })} type="number" />
        <Field label="통화" value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />
        <Field label="결제기한" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} type="date" />
        <label className="form-field">
          <span>상태</span>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="미수">미수</option>
            <option value="일부수금">일부수금</option>
            <option value="완납">완납</option>
            <option value="연체">연체</option>
          </select>
        </label>
        <Field label="메모" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={form.order_id === ""} onClick={save}>
          {form.id ? "수정 저장" : "AR 추가"}
        </button>
        <button className="btn" onClick={() => { setForm(emptyForm); clearSelection(); }}>신규 입력</button>
        <button className="btn danger" disabled={!form.id} onClick={remove}>삭제</button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent = "#0055a8",
}: {
  label: string;
  value: string | number;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: accent }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
