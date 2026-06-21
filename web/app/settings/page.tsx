"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  createSettingsCustomer,
  createSettingsItem,
  createSettingsUser,
  createSettingsVendor,
  createSettingsVessel,
  deleteSettingsCustomer,
  deleteSettingsItem,
  deleteSettingsVendor,
  deleteSettingsVessel,
  fetchCompanyProfile,
  fetchCustomers,
  fetchSettingsCustomers,
  fetchSettingsItems,
  fetchSettingsUsers,
  fetchSettingsVendors,
  fetchSettingsVessels,
  updateCompanyProfile,
  updateSettingsCustomer,
  updateSettingsItem,
  updateSettingsUser,
  updateSettingsVendor,
  updateSettingsVessel,
} from "@/lib/api";
import type {
  CompanyProfile,
  CustomerOption,
  SettingsCustomer,
  SettingsItem,
  SettingsUser,
  SettingsVendor,
  SettingsVessel,
} from "@/lib/types";
import AppShell, { SectionHead } from "@/components/AppShell";

type Tab = "company" | "users" | "customers" | "vendors" | "vessels" | "items";

const emptyCompany: CompanyProfile = {
  company_name_en: "",
  company_name_kr: "",
  address: "",
  business_no: "",
  phone: "",
  general_email: "",
  sales_email: "",
  tax_email: "",
  website: "",
  bank_name: "",
  bank_account: "",
  bank_holder: "",
  swift: "",
  tagline: "",
};

export default function SettingsPage() {
  return (
    <AppShell active="settings">
      <Settings />
    </AppShell>
  );
}

function Settings() {
  const [tab, setTab] = useState<Tab>("company");
  const tabs: { key: Tab; label: string }[] = [
    { key: "company", label: "회사 정보" },
    { key: "users", label: "사용자" },
    { key: "customers", label: "Customer" },
    { key: "vendors", label: "Vendor" },
    { key: "vessels", label: "선박" },
    { key: "items", label: "Item Master" },
  ];

  return (
    <>
      <SectionHead title="Settings" sub="회사정보 · 사용자 · 마스터 데이터 관리" />
      <div className="page-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "company" && <CompanyTab />}
      {tab === "users" && <UsersTab />}
      {tab === "customers" && <CustomersTab />}
      {tab === "vendors" && <VendorsTab />}
      {tab === "vessels" && <VesselsTab />}
      {tab === "items" && <ItemsTab />}
    </>
  );
}

function CompanyTab() {
  const [form, setForm] = useState<CompanyProfile>(emptyCompany);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchCompanyProfile().then((d) => setForm({ ...emptyCompany, ...d })).catch(() => setForm(emptyCompany));
  }, []);

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      await updateCompanyProfile(form);
      setMsg("저장 완료");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  const fields: { key: keyof CompanyProfile; label: string }[] = [
    { key: "company_name_en", label: "Company Name (EN)" },
    { key: "company_name_kr", label: "Company Name (KR)" },
    { key: "address", label: "Address" },
    { key: "business_no", label: "Business No." },
    { key: "phone", label: "Phone" },
    { key: "general_email", label: "General Email" },
    { key: "sales_email", label: "Sales Email" },
    { key: "tax_email", label: "Tax Email" },
    { key: "website", label: "Website" },
    { key: "bank_name", label: "Bank Name" },
    { key: "bank_account", label: "Bank Account" },
    { key: "bank_holder", label: "Bank Holder" },
    { key: "swift", label: "SWIFT" },
    { key: "tagline", label: "Tagline" },
  ];

  return (
    <div className="panel">
      <div className="form-grid">
        {fields.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            value={form[f.key] || ""}
            onChange={(v) => setForm({ ...form, [f.key]: v })}
          />
        ))}
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          회사 정보 저장
        </button>
        {msg ? <span className="hint-inline">{msg}</span> : null}
      </div>
    </div>
  );
}

function UsersTab() {
  const [rows, setRows] = useState<SettingsUser[]>([]);
  const [selected, setSelected] = useState<SettingsUser | null>(null);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const form = selected ?? { id: 0, username: "", email: "", role: "sales", is_active: true };

  function load() {
    fetchSettingsUsers().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "사용자 조회 실패"));
  }

  useEffect(load, []);

  async function save() {
    setErr("");
    try {
      const body = { username: form.username, email: form.email, role: form.role, is_active: form.is_active, password };
      if (form.id) await updateSettingsUser(form.id, body);
      else await createSettingsUser(body);
      setSelected(null);
      setPassword("");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    }
  }

  return (
    <div className="panel">
      <EditableTable
        rows={rows}
        selectedId={selected?.id ?? 0}
        columns={[
          ["username", "사용자명"],
          ["email", "Email"],
          ["role", "Role"],
          ["is_active", "Active"],
        ]}
        onSelect={(r) => {
          setSelected(r);
          setPassword("");
        }}
      />
      <div className="form-grid">
        <TextField label="사용자명 *" value={form.username} onChange={(v) => setSelected({ ...form, username: v })} />
        <TextField label="Email" value={form.email} onChange={(v) => setSelected({ ...form, email: v })} />
        <label className="form-field">
          <span>Role</span>
          <select value={form.role} onChange={(e) => setSelected({ ...form, role: e.target.value })}>
            <option value="admin">admin</option>
            <option value="sales">sales</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <TextField label={form.id ? "새 비밀번호 (변경 시)" : "비밀번호 *"} value={password} onChange={setPassword} type="password" />
        <label className="check-inline">
          <input type="checkbox" checked={form.is_active} onChange={(e) => setSelected({ ...form, is_active: e.target.checked })} />
          활성
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={save} disabled={!form.username.trim() || (!form.id && !password)}>
          {form.id ? "사용자 수정" : "사용자 추가"}
        </button>
        <button className="btn" onClick={() => { setSelected(null); setPassword(""); }}>
          신규 입력
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function CustomersTab() {
  return (
    <MasterSection<SettingsCustomer>
      title="Customer 관리"
      empty={{ id: 0, name: "", contact: "", email: "", country: "", address: "", tax_id: "" }}
      load={fetchSettingsCustomers}
      create={createSettingsCustomer}
      update={updateSettingsCustomer}
      remove={deleteSettingsCustomer}
      columns={[
        ["name", "Customer"],
        ["country", "Country"],
        ["contact", "Contact"],
        ["email", "Email"],
      ]}
      fields={[
        ["name", "Customer *"],
        ["country", "Country"],
        ["address", "Address"],
        ["contact", "Contact"],
        ["email", "Email"],
        ["tax_id", "Tax ID / Business No."],
      ]}
      required="name"
    />
  );
}

function VendorsTab() {
  return (
    <MasterSection<SettingsVendor>
      title="Vendor 관리"
      empty={{ id: 0, name: "", contact: "", email: "", specialization: "", country: "", address: "" }}
      load={fetchSettingsVendors}
      create={createSettingsVendor}
      update={updateSettingsVendor}
      remove={deleteSettingsVendor}
      columns={[
        ["name", "Vendor"],
        ["country", "Country"],
        ["contact", "Contact"],
        ["email", "Email"],
        ["specialization", "Specialization"],
      ]}
      fields={[
        ["name", "Vendor *"],
        ["country", "Country"],
        ["address", "Address"],
        ["contact", "Contact"],
        ["email", "Email"],
        ["specialization", "Specialization"],
      ]}
      required="name"
    />
  );
}

function VesselsTab() {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    fetchCustomers().then(setCustomers).catch(() => setCustomers([]));
  }, []);

  return (
    <MasterSection<SettingsVessel>
      title="선박 관리"
      empty={{ id: 0, name: "", imo: "", engine_type: "", hull_no: "", customer_id: null, customer: "" }}
      load={fetchSettingsVessels}
      create={(body) => {
        const { customer: _customer, ...payload } = body;
        return createSettingsVessel({ ...payload, customer_id: payload.customer_id ?? undefined });
      }}
      update={(id, body) => {
        const { customer: _customer, ...payload } = body;
        return updateSettingsVessel(id, payload);
      }}
      remove={deleteSettingsVessel}
      columns={[
        ["name", "Vessel"],
        ["imo", "IMO"],
        ["engine_type", "Engine"],
        ["hull_no", "Hull No."],
        ["customer", "Customer"],
      ]}
      fields={[
        ["name", "Vessel *"],
        ["imo", "IMO No."],
        ["engine_type", "Main Engine Type"],
        ["hull_no", "Hull No."],
      ]}
      required="name"
      extraForm={(form, setForm) => (
        <label className="form-field">
          <span>소유 Customer</span>
          <select
            value={form.customer_id ?? ""}
            onChange={(e) => setForm({ ...form, customer_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">없음</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      )}
    />
  );
}

function ItemsTab() {
  return (
    <MasterSection<SettingsItem>
      title="Item Master"
      empty={{ id: 0, part_no: "", description: "", maker: "", origin: "", unit: "PCS", hs_code: "", std_price: 0 }}
      load={fetchSettingsItems}
      create={createSettingsItem}
      update={updateSettingsItem}
      remove={deleteSettingsItem}
      columns={[
        ["part_no", "Part No."],
        ["description", "Description"],
        ["maker", "Maker"],
        ["origin", "Origin"],
        ["unit", "Unit"],
        ["hs_code", "HS Code"],
        ["std_price", "Std Price"],
      ]}
      fields={[
        ["part_no", "Part No. *"],
        ["description", "Description"],
        ["maker", "Maker"],
        ["origin", "Origin"],
        ["unit", "Unit"],
        ["hs_code", "HS Code"],
        ["std_price", "Std Price"],
      ]}
      required="part_no"
      numeric={["std_price"]}
    />
  );
}

function MasterSection<T extends { id: number }>({
  title,
  empty,
  load,
  create,
  update,
  remove,
  columns,
  fields,
  required,
  numeric = [],
  extraForm,
}: {
  title: string;
  empty: T;
  load: () => Promise<T[]>;
  create: (body: Omit<T, "id">) => Promise<unknown>;
  update: (id: number, body: Omit<T, "id">) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
  columns: [keyof T, string][];
  fields: [keyof T, string][];
  required: keyof T;
  numeric?: (keyof T)[];
  extraForm?: (form: T, setForm: (next: T) => void) => ReactNode;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [form, setForm] = useState<T>(empty);
  const [err, setErr] = useState("");
  const selected = useMemo(() => rows.find((r) => r.id === form.id) ?? null, [rows, form.id]);

  function refresh() {
    load().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "조회 실패"));
  }

  useEffect(refresh, []);

  async function save() {
    setErr("");
    try {
      const body = stripId(form);
      if (form.id) await update(form.id, body);
      else await create(body);
      setForm(empty);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function delRow() {
    if (!form.id || !confirm("선택한 항목을 삭제할까요?")) return;
    setErr("");
    try {
      await remove(form.id);
      setForm(empty);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  const requiredValue = String(form[required] ?? "").trim();

  return (
    <div className="panel">
      <h3 className="form-title">{title}</h3>
      <EditableTable rows={rows} selectedId={form.id} columns={columns} onSelect={setForm} />
      <div className="form-grid">
        {fields.map(([key, label]) => (
          <TextField
            key={String(key)}
            label={label}
            type={numeric.includes(key) ? "number" : "text"}
            value={String(form[key] ?? "")}
            onChange={(v) => setForm({ ...form, [key]: numeric.includes(key) ? Number(v) : v })}
          />
        ))}
        {extraForm?.(form, setForm)}
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={!requiredValue} onClick={save}>
          {selected ? "수정 저장" : "신규 추가"}
        </button>
        <button className="btn" onClick={() => setForm(empty)}>신규 입력</button>
        <button className="btn danger" disabled={!form.id} onClick={delRow}>삭제</button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function EditableTable<T extends { id: number }>({
  rows,
  selectedId,
  columns,
  onSelect,
}: {
  rows: T[];
  selectedId: number;
  columns: [keyof T, string][];
  onSelect: (row: T) => void;
}) {
  if (rows.length === 0) return <div className="state">등록된 항목이 없습니다.</div>;
  return (
    <div className="table-wrap">
      <table className="mini wide">
        <thead>
          <tr>
            {columns.map(([, label]) => <th key={label}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.id === selectedId ? "sel" : ""} onClick={() => onSelect(row)}>
              {columns.map(([key]) => (
                <td key={String(key)}>{String(row[key] ?? "") || "-"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextField({
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

function stripId<T extends { id: number }>(row: T): Omit<T, "id"> {
  const { id: _id, ...rest } = row;
  return rest;
}
