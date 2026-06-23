"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  createSettingsCustomer,
  createSettingsItem,
  createSettingsUser,
  createSettingsVendor,
  createSettingsVessel,
  changeMyPassword,
  deleteSettingsCustomer,
  deleteSettingsItem,
  deleteSettingsUser,
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
import { getUser } from "@/lib/auth";
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

const COMPANY_FIELDS: { key: keyof CompanyProfile; label: string }[] = [
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

function CompanyTab() {
  const [form, setForm] = useState<CompanyProfile>(emptyCompany);
  const [saved, setSaved] = useState<CompanyProfile>(emptyCompany); // 마지막 저장값(읽기 화면·취소용)
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchCompanyProfile()
      .then((d) => {
        const merged = { ...emptyCompany, ...d };
        setForm(merged);
        setSaved(merged);
      })
      .catch(() => {
        setForm(emptyCompany);
        setSaved(emptyCompany);
      });
  }, []);

  function startEdit() {
    setForm(saved);
    setMsg("");
    setEditing(true);
  }

  function cancel() {
    setForm(saved);
    setEditing(false);
    setMsg("");
  }

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      await updateCompanyProfile(form);
      setSaved(form);
      setEditing(false);
      setMsg("저장 완료");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  // 저장 후/기본: 정리된 읽기 화면
  if (!editing) {
    return (
      <div className="panel">
        <dl className="company-view">
          {COMPANY_FIELDS.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{saved[f.key] ? saved[f.key] : <span className="dash">—</span>}</dd>
            </div>
          ))}
        </dl>
        <div className="form-actions">
          <button className="btn primary" onClick={startEdit}>
            ✎ 회사 정보 수정
          </button>
          {msg ? <span className="hint-inline">{msg}</span> : null}
        </div>
      </div>
    );
  }

  // 수정: 입력 폼
  return (
    <div className="panel">
      <div className="form-grid">
        {COMPANY_FIELDS.map((f) => (
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
          {busy ? "저장 중…" : "회사 정보 저장"}
        </button>
        <button className="btn" disabled={busy} onClick={cancel}>
          취소
        </button>
        {msg ? <span className="hint-inline">{msg}</span> : null}
      </div>
    </div>
  );
}

const EMPTY_USER: SettingsUser = { id: 0, username: "", email: "", role: "sales", is_active: true };

function UsersTab() {
  const NEW_ID = -1;
  const [rows, setRows] = useState<SettingsUser[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<SettingsUser>(EMPTY_USER);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const me = getUser();
  const isEdit = !!editId && editId > 0;
  const isSelf = isEdit && me?.id === editId;

  function load() {
    fetchSettingsUsers().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "사용자 조회 실패"));
  }

  useEffect(load, []);

  function openNew() {
    setForm(EMPTY_USER);
    setPassword("");
    setErr("");
    setEditId(NEW_ID);
  }
  function openEdit(u: SettingsUser) {
    setForm(u);
    setPassword("");
    setErr("");
    setEditId(u.id);
  }
  function cancel() {
    setForm(EMPTY_USER);
    setPassword("");
    setErr("");
    setEditId(null);
  }

  async function save() {
    setErr("");
    try {
      const body = { username: form.username, email: form.email, role: form.role, is_active: form.is_active, password };
      if (isEdit) await updateSettingsUser(editId, body);
      else await createSettingsUser(body);
      cancel();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function remove() {
    if (!isEdit || !confirm("이 사용자를 삭제할까요?")) return;
    setErr("");
    try {
      await deleteSettingsUser(editId);
      cancel();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  const editorTitle = isEdit ? `✎ ${form.username || "사용자"} 수정` : "+ 신규 사용자";
  const editor = editId !== null ? (
    <div className="ms-editor">
      <div className="ms-editor-head">{editorTitle}</div>
      <div className="form-grid">
        <TextField label="사용자명 *" value={form.username} onChange={(v) => setForm({ ...form, username: v })} />
        <TextField label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
        <label className="form-field">
          <span>Role</span>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">admin</option>
            <option value="sales">sales</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <TextField
          label={isEdit ? "새 비밀번호 (변경 시)" : "비밀번호 *"}
          value={password}
          onChange={setPassword}
          type="password"
        />
        <label className="check-inline">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          활성 (비활성화 시 로그인 차단)
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={save} disabled={!form.username.trim() || (!isEdit && !password)}>
          {isEdit ? "수정 저장" : "신규 추가"}
        </button>
        <button className="btn" onClick={cancel}>
          취소
        </button>
        {isEdit && !isSelf ? (
          <button className="btn danger" onClick={remove}>
            삭제
          </button>
        ) : null}
        {isSelf ? <span className="hint-inline">본인 계정은 비활성화/비밀번호 변경만 가능합니다.</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  ) : null;

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">사용자 관리</h3>
        <button className="btn primary" onClick={openNew} disabled={editId === NEW_ID}>
          + 사용자 추가
        </button>
      </div>

      {editor}

      {rows.length === 0 ? (
        <div className="state">등록된 사용자가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="mini wide ms-table">
            <thead>
              <tr>
                <th>사용자명</th>
                <th>Email</th>
                <th>Role</th>
                <th>상태</th>
                <th className="ms-actcol"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={u.id === editId ? "sel" : ""} onClick={() => openEdit(u)}>
                  <td>{u.username}</td>
                  <td>{u.email || "—"}</td>
                  <td>{u.role}</td>
                  <td>
                    <span className={`status-badge${u.is_active ? " on" : " off"}`}>
                      {u.is_active ? "✓ 활성" : "— 비활성"}
                    </span>
                  </td>
                  <td className="ms-actcol" onClick={(e) => { e.stopPropagation(); openEdit(u); }}>
                    <span className="ms-edit-btn" title="수정">✎</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MyPasswordChange />
    </div>
  );
}

function MyPasswordChange() {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const me = getUser();

  async function submit() {
    setErr("");
    setMsg("");
    if (newPw !== newPw2) {
      setErr("새 비밀번호가 일치하지 않습니다.");
      return;
    }
    try {
      await changeMyPassword(oldPw, newPw);
      setMsg("비밀번호가 변경되었습니다.");
      setOldPw("");
      setNewPw("");
      setNewPw2("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "변경 실패");
    }
  }

  return (
    <div className="subpanel" style={{ marginTop: 20 }}>
      <div className="sub-h">내 비밀번호 변경{me ? ` — ${me.username}` : ""}</div>
      <div className="form-grid">
        <TextField label="현재 비밀번호" value={oldPw} onChange={setOldPw} type="password" />
        <TextField label="새 비밀번호" value={newPw} onChange={setNewPw} type="password" />
        <TextField label="새 비밀번호 확인" value={newPw2} onChange={setNewPw2} type="password" />
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={!oldPw || !newPw || !newPw2}>
          비밀번호 변경
        </button>
        {err ? <span className="action-err">{err}</span> : null}
        {msg ? <span className="action-ok">{msg}</span> : null}
      </div>
    </div>
  );
}

function CustomersTab() {
  return (
    <MasterSection<SettingsCustomer>
      title="Customer 관리"
      empty={{ id: 0, name: "", contact: "", contact_phone: "", email: "", country: "", address: "", tax_id: "" }}
      load={fetchSettingsCustomers}
      create={createSettingsCustomer}
      update={updateSettingsCustomer}
      remove={deleteSettingsCustomer}
      columns={[
        ["name", "Customer"],
        ["country", "Country"],
        ["contact", "담당자"],
        ["email", "Email"],
      ]}
      fields={[
        ["name", "Customer *"],
        ["country", "Country"],
        ["address", "Address"],
        ["contact", "담당자 이름"],
        ["contact_phone", "담당자 연락처"],
        ["email", "담당자 이메일"],
        ["tax_id", "Tax ID / Business No."],
      ]}
      required="name"
      allowCopy
      copyHint="같은 고객사의 다른 담당자를 등록하려면 담당자(Contact)·이메일만 바꿔 저장하세요."
    />
  );
}

function VendorsTab() {
  return (
    <MasterSection<SettingsVendor>
      title="Vendor 관리"
      empty={{ id: 0, name: "", contact: "", contact_phone: "", email: "", specialization: "", country: "", address: "" }}
      load={fetchSettingsVendors}
      create={createSettingsVendor}
      update={updateSettingsVendor}
      remove={deleteSettingsVendor}
      columns={[
        ["name", "Vendor"],
        ["country", "Country"],
        ["contact", "담당자"],
        ["email", "Email"],
        ["specialization", "Specialization"],
      ]}
      fields={[
        ["name", "Vendor *"],
        ["country", "Country"],
        ["address", "Address"],
        ["contact", "담당자 이름"],
        ["contact_phone", "담당자 연락처"],
        ["email", "담당자 이메일"],
        ["specialization", "Specialization"],
      ]}
      required="name"
      allowCopy
      copyHint="같은 Vendor의 다른 담당자를 등록하려면 담당자(Contact)·이메일만 바꿔 저장하세요."
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
      empty={{ id: 0, name: "", imo: "", vessel_type: "", ais_flag: "", engine_type: "", hull_no: "", customer_id: null, customer: "" }}
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
        ["vessel_type", "선박 타입"],
        ["ais_flag", "AIS Flag"],
        ["customer", "Customer"],
      ]}
      fields={[
        ["name", "Vessel *"],
        ["imo", "IMO No."],
        ["ais_flag", "AIS Flag (기국)"],
        ["engine_type", "Main Engine Type"],
        ["hull_no", "Hull No."],
      ]}
      required="name"
      extraForm={(form, setForm) => (
        <>
          <label className="form-field">
            <span>선박 타입</span>
            <input
              list="vessel-type-list"
              value={form.vessel_type ?? ""}
              onChange={(e) => setForm({ ...form, vessel_type: e.target.value })}
              placeholder="선택 또는 직접 입력"
            />
            <datalist id="vessel-type-list">
              {VESSEL_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
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
        </>
      )}
    />
  );
}

const VESSEL_TYPES = [
  "Container Ship",
  "Crude Oil Tanker",
  "Product Tanker",
  "Chemical Tanker",
  "Bulk Carrier",
  "Bunkering Tanker",
  "LNG Carrier",
  "LPG Carrier",
  "General Cargo",
  "Car Carrier (PCTC)",
  "Reefer",
  "Passenger / Ro-Pax",
  "Tug / Offshore",
];

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
  allowCopy = false,
  copyHint,
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
  allowCopy?: boolean; // 기존 항목 정보를 복사해 새 레코드로 등록 허용
  copyHint?: string; // 복사 모드 안내 문구
}) {
  const NEW_ID = -1; // editId 센티넬: 신규 등록 편집기
  const [rows, setRows] = useState<T[]>([]);
  const [editId, setEditId] = useState<number | null>(null); // null=닫힘, -1=신규, >0=수정
  const [form, setForm] = useState<T>(empty);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [copying, setCopying] = useState(false); // 복사 모드(기존 정보 복제 → 새 레코드)

  function refresh() {
    load().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "조회 실패"));
  }

  useEffect(refresh, []);

  function openNew() {
    setForm(empty);
    setErr("");
    setCopying(false);
    setEditId(NEW_ID);
  }
  function openEdit(row: T) {
    setForm(row);
    setErr("");
    setCopying(false);
    setEditId(row.id);
  }
  // 현재 편집 중인 항목의 정보를 그대로 둔 채 '신규 등록'으로 전환한다(저장 시 새 레코드 생성).
  function copyAsNew() {
    setForm({ ...form, id: 0 });
    setErr("");
    setCopying(true);
    setEditId(NEW_ID);
  }
  function cancel() {
    setForm(empty);
    setErr("");
    setCopying(false);
    setEditId(null);
  }

  async function save() {
    setErr("");
    try {
      const body = stripId(form);
      if (editId && editId > 0) await update(editId, body);
      else await create(body);
      cancel();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function delRow() {
    if (!editId || editId < 0 || !confirm("선택한 항목을 삭제할까요?")) return;
    setErr("");
    try {
      await remove(editId);
      cancel();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  const requiredValue = String(form[required] ?? "").trim();
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? rows.filter((r) => columns.some(([key]) => String(r[key] ?? "").toLowerCase().includes(ql)))
    : rows;
  const isEdit = !!editId && editId > 0;

  const editorTitle = isEdit
    ? `✎ ${String(form[required] ?? "") || "항목"} 수정`
    : copying
    ? `📋 복사하여 새로 등록${String(form[required] ?? "") ? ` — ${String(form[required])}` : ""}`
    : "+ 신규 등록";
  const editor = editId !== null ? (
    <div className="ms-editor">
      <div className="ms-editor-head">{editorTitle}</div>
      {copying && copyHint ? <div className="ms-copy-hint">{copyHint}</div> : null}
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
          {isEdit ? "수정 저장" : "신규 추가"}
        </button>
        {isEdit && allowCopy ? (
          <button className="btn" onClick={copyAsNew} title="이 정보를 복사해 새 레코드로 등록">
            📋 복사하여 새로 등록
          </button>
        ) : null}
        <button className="btn" onClick={cancel}>
          취소
        </button>
        {isEdit ? (
          <button className="btn danger" onClick={delRow}>
            삭제
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  ) : null;

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">{title}</h3>
        <input
          className="ms-search"
          placeholder="🔍 검색…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn primary" onClick={openNew} disabled={editId === NEW_ID}>
          + 신규 등록
        </button>
      </div>

      {editor}

      {filtered.length === 0 ? (
        <div className="state">{ql ? "검색 결과가 없습니다." : "등록된 항목이 없습니다."}</div>
      ) : (
        <div className="table-wrap">
          <table className="mini wide ms-table">
            <thead>
              <tr>
                {columns.map(([, label]) => (
                  <th key={label}>{label}</th>
                ))}
                <th className="ms-actcol"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  className={row.id === editId ? "sel" : ""}
                  onClick={() => openEdit(row)}
                >
                  {columns.map(([key]) => (
                    <td key={String(key)}>{String(row[key] ?? "") || "—"}</td>
                  ))}
                  <td
                    className="ms-actcol"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(row);
                    }}
                  >
                    <span className="ms-edit-btn" title="수정">
                      ✎
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
