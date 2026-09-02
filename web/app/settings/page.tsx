"use client";

import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
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
  parseBusinessCard,
  updateCompanyProfile,
  updateCustomerCompanyInfo,
  updateVendorCompanyInfo,
  updateSettingsCustomer,
  updateSettingsItem,
  updateSettingsUser,
  updateSettingsVendor,
  updateSettingsVessel,
  fetchSettingsConsultants,
  createSettingsConsultant,
  updateSettingsConsultant,
  deleteSettingsConsultant,
  fetchRolePermissions,
  updateRolePermissions,
  fetchItemCategories,
  createItemCategory,
  updateItemCategory,
  deleteItemCategory,
  fetchItemLedger,
  fetchItemPriceHistory,
  purgeUnusedItems,
  rebuildItemLedger,
  assignItemLedgerCategory,
  assignItemLedgerCategoryBulk,
  previewAutoClassify,
  applyAutoClassify,
  fetchEmailTemplates,
  saveEmailTemplate,
  deleteEmailTemplate,
  previewEmailTemplate,
  fetchEmailSignature,
  saveEmailSignature,
  previewEmailSignature,
  fetchMailStatus,
  syncMail,
} from "@/lib/api";
import type { MailStatus } from "@/lib/types";
import type {
  PermissionsConfig,
  RolePermRow,
  EmailTemplatesData,
  CompanyInfoSave,
  SignatureFields,
} from "@/lib/api";
import type { PermGrid } from "@/lib/auth";
import { toggleBold, onBoldKey } from "@/lib/mdEdit";
import type {
  BusinessCardOcr,
  CompanyProfile,
  CustomerOption,
  SettingsCustomer,
  SettingsItem,
  ItemCategory,
  ItemLedger,
  ItemLedgerRow,
  AutoCategoryProposal,
  ItemPriceRow,
  SettingsUser,
  SettingsVendor,
  SettingsVessel,
  SettingsConsultant,
} from "@/lib/types";
import { getUser, isAdmin, can } from "@/lib/auth";
import AppShell, { SectionHead } from "@/components/AppShell";
import Modal from "@/components/common/Modal";
import { invalidateCustomerLogos } from "@/lib/customerLogos";
import { invalidateVendorLogos } from "@/lib/vendorLogos";
import { downscaleImageFile, fileToLogoDataUrl, imageFromClipboard } from "@/lib/imagePaste";
import { PAYMENT_TERMS_PRESETS } from "@/lib/terms";
import ComboBox from "@/components/common/ComboBox";
import { useColumnLayout } from "@/components/common/useColumnLayout";
import { ColumnResizer, ColumnsButton, dragHandleProps } from "@/components/common/tableLayout";
import { invalidateMasterCategories } from "@/components/common/CategoryCell";
// 목록의 상대처는 다른 화면과 같은 모양(로고 + 이름)으로 — 같은 회사를 두 표기로 읽지 않도록.
import CustomerName from "@/components/common/CustomerName";
import VendorName from "@/components/common/VendorName";
import ProjectNo from "@/components/common/ProjectNo";
// 머리 칸 정렬·필터 — 진행현황·지급대장 표에서 쓰는 장치를 마스터 목록에도 그대로 쓴다.
import { HeadTh, useHeadMenu, type HeadCol } from "@/components/common/tableHeadMenu";

// 탭. 예전에는 Users / Permissions 가 갈려 있고 Customer / Vendor 도 따로였다.
// 둘 다 한 가지 일을 두 자리에서 하게 만들던 구분이라 합쳤다 — 계정과 그 계정이 할 수
// 있는 일은 같은 물음이고, 고객과 벤더는 같은 상대처 명부를 사고 파는 방향으로만
// 나눈 것이다. ?tab= 링크는 옛 이름으로 들어와도 새 탭으로 보낸다(TAB_ALIAS).
type Tab =
  | "company" | "users"
  | "partners" | "vessels" | "consultants" | "email" | "mail" | "account";

/** 옛 ?tab= 값 → 지금 탭. 밖에 나가 있는 링크·북마크가 죽지 않게. */
const TAB_ALIAS: Record<string, Tab> = {
  permissions: "users",
  customers: "partners",
  vendors: "partners",
};

const emptyCompany: CompanyProfile = {
  company_name_en: "",
  company_name_kr: "",
  address: "",
  address_en: "",
  business_no: "",
  phone: "",
  general_email: "",
  sales_email: "",
  tax_email: "",
  website: "",
  bank_name: "",
  bank_account: "",
  bank_holder: "",
  fx_bank_name: "",
  fx_bank_account: "",
  fx_bank_holder: "",
  swift: "",
  tagline: "",
  email_signature: "",
};

export default function SettingsPage() {
  return (
    // Projects 페이지와 동일하게 전체 폭 사용(wide) — 목록/가격표가 넓게 보이도록.
    <AppShell active="settings" wide>
      {/* Settings 가 useSearchParams(?tab=) 를 쓰므로 Suspense 로 감싼다. */}
      <Suspense fallback={<div className="state">Loading…</div>}>
        <Settings />
      </Suspense>
    </AppShell>
  );
}

function Settings() {
  const admin = isAdmin();
  // 다른 화면에서 특정 탭으로 곧장 보내는 링크(?tab=mail 등)를 받는다.
  const params = useSearchParams();
  // 마스터 데이터(고객사·Vendor·선박·품목) 관리 = "settings" 권한. admin 은 항상 허용.
  // 회사/사용자/권한 설정은 admin 전용으로 유지한다.
  const canMaster = admin || can("settings", "view");
  const [tab, setTab] = useState<Tab>(() => {
    const raw = params.get("tab") || "";
    const asked = (TAB_ALIAS[raw] ?? raw) as Tab;
    // 링크로 들어온 탭이라도 권한이 없으면 기본 탭으로 — Mailbox 는 admin 전용이다.
    if (asked === "mail" && admin) return asked;
    if (asked === "partners" && (admin || canMaster)) return asked;
    return admin ? "company" : canMaster ? "partners" : "account";
  });

  // 마스터 데이터 권한도 없는 사용자(예: 권한 없는 viewer)는 본인 비밀번호 변경만.
  if (!admin && !canMaster) {
    return (
      <>
        <SectionHead title="My Account" sub="Password" />
        <h3 className="form-title">My account</h3>
        <p className="hint-inline" style={{ display: "block", marginBottom: 8 }}>
          Company, user, and master-data settings are available to administrators only.
        </p>
        <MyPasswordChange />
      </>
    );
  }

  // admin: 전체 탭. 비관리자(마스터 권한 보유): 마스터 데이터 탭 + 내 계정만.
  const tabs: { key: Tab; label: string }[] = admin
    ? [
        { key: "company", label: "Company" },
        { key: "users", label: "Users & Permissions" },
        { key: "partners", label: "Partners" },
        { key: "vessels", label: "Vessels" },
        { key: "consultants", label: "Consultant" },
        { key: "email", label: "Email Templates" },
        { key: "mail", label: "Mailbox" },
      ]
    : [
        { key: "partners", label: "Partners" },
        { key: "vessels", label: "Vessels" },
        { key: "consultants", label: "Consultant" },
        { key: "email", label: "Email Templates" },
        { key: "account", label: "My Account" },
      ];

  return (
    <>
      <SectionHead
        title="Settings"
        sub={admin ? "Company · users · master data" : "Master data"}
      />
      <div className="page-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {admin && tab === "company" && <CompanyTab />}
      {admin && tab === "users" && <UsersTab />}
      {tab === "partners" && <PartnersTab />}
      {tab === "vessels" && <VesselsTab />}
      {tab === "consultants" && <ConsultantsTab />}
      {tab === "email" && <EmailTemplatesTab />}
      {admin && tab === "mail" && <MailboxTab />}
      {tab === "account" && (
        <div className="panel">
          <MyPasswordChange />
        </div>
      )}
    </>
  );
}

type CompanyField = { key: keyof CompanyProfile; label: string; groupBefore?: string };

// 국문(좌) — 한글 회사명·주소 + 국내계좌
const KR_FIELDS: CompanyField[] = [
  { key: "company_name_kr", label: "Company Name (KR)" },
  { key: "address", label: "Address (KR)" },
  { key: "bank_name", label: "Bank", groupBefore: "Domestic Account" },
  { key: "bank_account", label: "Account No." },
  { key: "bank_holder", label: "Holder" },
];

// 영문(우) — 영문 회사명·주소 + 외화계좌
const EN_FIELDS: CompanyField[] = [
  { key: "company_name_en", label: "Company Name (EN)" },
  { key: "address_en", label: "Address (EN)" },
  { key: "fx_bank_name", label: "Bank", groupBefore: "FX Account" },
  { key: "fx_bank_account", label: "Account No." },
  { key: "fx_bank_holder", label: "Holder" },
  { key: "swift", label: "SWIFT" },
];

// 공통 — 한·영 공용(사업자번호·전화·이메일·웹사이트·태그라인)
const COMMON_FIELDS: CompanyField[] = [
  { key: "business_no", label: "Business No." },
  { key: "phone", label: "Phone" },
  { key: "general_email", label: "General Email" },
  { key: "sales_email", label: "Sales Email" },
  { key: "tax_email", label: "Tax Email" },
  { key: "website", label: "Website" },
  { key: "tagline", label: "Tagline" },
];

const BILINGUAL_COLS: { title: string; fields: CompanyField[] }[] = [
  { title: "Korean", fields: KR_FIELDS },
  { title: "English", fields: EN_FIELDS },
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
      setMsg("Saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  // 저장 후/기본: 정리된 읽기 화면
  if (!editing) {
    return (
      <div className="panel">
        <div className="bilingual-cols">
          {BILINGUAL_COLS.map((col) => (
            <section className="bl-col" key={col.title}>
              <h4 className="bl-col-title">{col.title}</h4>
              <dl className="company-view bl-view">
                {col.fields.map((f) => (
                  <Fragment key={f.key}>
                    {f.groupBefore ? <div className="bl-group-label">{f.groupBefore}</div> : null}
                    <div>
                      <dt>{f.label}</dt>
                      <dd>{saved[f.key] ? saved[f.key] : <span className="dash">—</span>}</dd>
                    </div>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <h4 className="bl-col-title bl-common-title">Common</h4>
        <dl className="company-view">
          {COMMON_FIELDS.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{saved[f.key] ? saved[f.key] : <span className="dash">—</span>}</dd>
            </div>
          ))}
          <div>
            <dt>Email signature</dt>
            <dd>
              {saved.email_signature ? (
                <span style={{ whiteSpace: "pre-wrap" }}>{saved.email_signature}</span>
              ) : (
                <span className="dash">— (default signature)</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="form-actions">
          <button className="btn primary" onClick={startEdit}>
            ✎ Edit company info
          </button>
          {msg ? <span className="hint-inline">{msg}</span> : null}
        </div>
      </div>
    );
  }

  // 수정: 입력 폼
  return (
    <div className="panel">
      <div className="bilingual-cols">
        {BILINGUAL_COLS.map((col) => (
          <section className="bl-col" key={col.title}>
            <h4 className="bl-col-title">{col.title}</h4>
            {col.fields.map((f) => (
              <Fragment key={f.key}>
                {f.groupBefore ? <div className="bl-group-label">{f.groupBefore}</div> : null}
                <TextField
                  label={f.label}
                  value={form[f.key] || ""}
                  onChange={(v) => setForm({ ...form, [f.key]: v })}
                />
              </Fragment>
            ))}
          </section>
        ))}
      </div>
      <h4 className="bl-col-title bl-common-title">Common</h4>
      <div className="form-grid">
        {COMMON_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            value={form[f.key] || ""}
            onChange={(v) => setForm({ ...form, [f.key]: v })}
          />
        ))}
      </div>
      <div className="form-field" style={{ marginTop: 12 }}>
        <label>Email signature</label>
        <textarea
          className="po-textarea"
          value={form.email_signature || ""}
          onChange={(e) => setForm({ ...form, email_signature: e.target.value })}
          placeholder="Signature appended to the bottom of outgoing emails. Leave blank to use the default."
        />
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save company info"}
        </button>
        <button className="btn" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        {msg ? <span className="hint-inline">{msg}</span> : null}
      </div>
    </div>
  );
}

const EMPTY_USER: SettingsUser = { id: 0, username: "", email: "", role: "sales", is_active: true };

// 역할별 권한 설명 — admin 이 계정에 권한을 부여할 때 참고. (백엔드 RBAC 와 일치)
const ROLE_INFO: { key: string; title: string; perms: string[] }[] = [
  {
    key: "admin",
    title: "Admin",
    perms: [
      "All deals: create / edit / delete",
      "Settings: company, users, master data (customers·vendors·vessels·items)",
      "Assign roles to other accounts",
    ],
  },
  {
    key: "sales",
    title: "Sales",
    perms: [
      "Deals: create / edit / delete (RFQ·Quotation·P/O·AR·Documents)",
      "Sees ONLY their own deals",
      "Master data (customer·vendor·vessel·item) if granted in Permissions",
      "No company / user / permission settings",
    ],
  },
  {
    key: "viewer",
    title: "Viewer",
    perms: [
      "Read-only — can view all screens",
      "Cannot create / edit / delete anything",
      "No access to settings",
    ],
  },
];
const ROLE_BY_KEY = Object.fromEntries(ROLE_INFO.map((r) => [r.key, r]));

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
    fetchSettingsUsers().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "Failed to load users"));
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
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function remove() {
    if (!isEdit || !confirm("Delete this user?")) return;
    setErr("");
    try {
      await deleteSettingsUser(editId);
      cancel();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const editorTitle = isEdit ? `✎ Edit ${form.username || "user"}` : "+ New user";
  const editor = editId !== null ? (
    <Modal title={editorTitle} onClose={cancel} form>
      <div className="form-grid">
        {/* 관리자가 '남의 계정'을 만들거나 고치는 자리다 — 브라우저가 저장해 둔 제 아이디·
            비밀번호를 밀어 넣으면 엉뚱한 사람의 계정이 만들어진다. 그래서 이 칸들은
            자동완성 대상이 아니라고 못박아 둔다(비밀번호는 new-password 로). */}
        <TextField label="Username *" value={form.username} onChange={(v) => setForm({ ...form, username: v })} autoComplete="off" />
        <TextField label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} autoComplete="off" />
        <label className="form-field">
          <span>Role</span>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">admin</option>
            <option value="sales">sales</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <TextField
          label={isEdit ? "New password (if changing)" : "Password *"}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="new-password"
        />
        <label className="check-inline">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          Active (inactive blocks login)
        </label>
      </div>
      {ROLE_BY_KEY[form.role] ? (
        <div className="role-perm-note">
          <span className="role-perm-title">{ROLE_BY_KEY[form.role].title} can:</span>
          <ul>
            {ROLE_BY_KEY[form.role].perms.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="form-actions">
        <button className="btn primary" onClick={save} disabled={!form.username.trim() || (!isEdit && !password)}>
          {isEdit ? "Save" : "Add"}
        </button>
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        {isEdit && !isSelf ? (
          <button className="btn danger" onClick={remove}>
            Delete
          </button>
        ) : null}
        {isSelf ? <span className="hint-inline">For your own account, only deactivation/password change is allowed.</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  ) : null;

  return (
    <>
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">User management</h3>
        <button className="btn primary" onClick={openNew} disabled={editId === NEW_ID}>
          + Add user
        </button>
      </div>

      {/* 역할별 권한 범례 — 계정을 만들며 "어느 역할을 줄까"를 정할 때 읽는 요약이다.
          손으로 적어 둔 글이라, 아래 매트릭스를 고치면 이 요약과 어긋날 수 있다.
          그래서 같은 화면에 둔 김에 어느 쪽이 진짜인지 한 줄로 밝혀 둔다. */}
      <div className="role-legend">
        {ROLE_INFO.map((r) => (
          <div key={r.key} className="role-legend-card">
            <div className={`role-legend-head role-${r.key}`}>{r.title}</div>
            <ul>
              {r.perms.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="hint-inline role-legend-note">
        What each role is meant for. What it can actually do is the matrix below — edit it there.
      </p>

      {editor}

      {rows.length === 0 ? (
        <div className="state">No users registered.</div>
      ) : (
        <div className="table-wrap">
          <table className="mini wide ms-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th className="ms-actcol"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={u.id === editId ? "sel" : ""} onClick={() => openEdit(u)}>
                  <td>{u.username}</td>
                  <td>{u.email || "—"}</td>
                  <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                  <td>
                    <span className={`status-badge${u.is_active ? " on" : " off"}`}>
                      {u.is_active ? "✓ Active" : "— Inactive"}
                    </span>
                  </td>
                  <td className="ms-actcol" onClick={(e) => { e.stopPropagation(); openEdit(u); }}>
                    <span className="ms-edit-btn" title="Edit">✎</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MyPasswordChange />
    </div>
      {/* 역할이 실제로 무엇을 할 수 있는지 — 위의 범례가 말로 요약한 것의 원본이다.
          계정을 만드는 자리와 그 계정이 할 수 있는 일을 정하는 자리를 갈라 두면,
          역할을 고르다 말고 다른 탭으로 건너가 확인하고 돌아와야 했다. */}
      <PermissionsTab />
    </>
  );
}

// ── 권한 매트릭스 편집 (admin 전용) ──────────────────────────────────────────
// 라벨은 현재 상단 메뉴 기준. 권한 키(progress/rfq/po/documents/ar)는 API 가드가 그대로
// 쓰므로 바꾸지 않는다 — 다만 RFQ·P/O·Documents·AR 은 전용 메뉴가 사라지고 프로젝트
// 팝업의 단계별 작업 권한이 되었으므로 별도 그룹으로 묶어 보여준다.
const MODULE_LABEL: Record<string, string> = {
  dashboard: "Dashboard",
  progress: "Projects",
  rfq: "RFQ & Quotation",
  po: "P/O",
  documents: "Documents",
  ar: "AR",
  finance: "Finance",
  marketing: "Marketing",
  settings: "Settings",
};
// 메뉴명만으로 범위가 분명하지 않은 항목의 부연.
const MODULE_HINT: Record<string, string> = {
  progress: "Projects + Activity",
  settings: "Settings + Item master",
};
// 표시 순서/그룹 — 상단 메뉴 순서대로 먼저, 단계별 작업 권한을 뒤에.
const MENU_MODULES = ["dashboard", "progress", "finance", "marketing", "settings"];
const STAGE_MODULES = ["rfq", "po", "documents", "ar"];

/** 백엔드가 준 모듈 목록을 [메뉴 그룹, 단계 그룹]으로 재배열(모르는 키는 메뉴 그룹 끝). */
function groupModules(modules: string[]): { title: string; modules: string[] }[] {
  const known = new Set([...MENU_MODULES, ...STAGE_MODULES]);
  const menu = [
    ...MENU_MODULES.filter((m) => modules.includes(m)),
    ...modules.filter((m) => !known.has(m)),
  ];
  const stage = STAGE_MODULES.filter((m) => modules.includes(m));
  return [
    { title: "Menu — 상단 메뉴", modules: menu },
    { title: "Project stage work — 프로젝트 상세의 단계별 작업", modules: stage },
  ].filter((g) => g.modules.length > 0);
}
const ACTION_LABEL: Record<string, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
};
const PERM_ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  sales: "Sales",
  viewer: "Viewer",
};

function clonePerms(p: PermGrid): PermGrid {
  return JSON.parse(JSON.stringify(p));
}

function PermissionsTab() {
  const [cfg, setCfg] = useState<PermissionsConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, { perms: PermGrid; scope: string }>>({});
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  function loadInto(c: PermissionsConfig) {
    const d: Record<string, { perms: PermGrid; scope: string }> = {};
    c.roles.filter((r) => r.editable).forEach((r) => {
      d[r.role] = { perms: clonePerms(r.perms), scope: r.scope };
    });
    setDraft(d);
  }

  useEffect(() => {
    fetchRolePermissions()
      .then((c) => {
        setCfg(c);
        loadInto(c);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  if (err && !cfg) return <div className="state error">{err}</div>;
  if (!cfg) return <div className="state">Loading…</div>;

  const viewOnly = new Set(cfg.view_only);

  function toggle(role: string, module: string, action: string) {
    setDraft((prev) => {
      const cur = prev[role];
      if (!cur) return prev;
      const next = clonePerms(cur.perms);
      next[module] = { ...(next[module] || {}) };
      next[module][action] = !next[module][action];
      // 열람을 끄면 입력/수정/삭제도 무의미하므로 함께 해제.
      if (action === "view" && !next[module][action]) {
        ["create", "edit", "delete"].forEach((a) => (next[module][a] = false));
      }
      return { ...prev, [role]: { ...cur, perms: next } };
    });
    setMsg("");
  }

  function setScope(role: string, scope: string) {
    setDraft((prev) =>
      prev[role] ? { ...prev, [role]: { ...prev[role], scope } } : prev
    );
    setMsg("");
  }

  async function save(role: string) {
    const d = draft[role];
    if (!d) return;
    setSavingRole(role);
    setErr("");
    setMsg("");
    try {
      await updateRolePermissions({ role, perms: d.perms, scope: d.scope });
      setMsg(`${PERM_ROLE_LABEL[role] ?? role} permissions saved.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingRole(null);
    }
  }

  function RoleCard({ row }: { row: RolePermRow }) {
    const editable = row.editable;
    const state = editable ? draft[row.role] : { perms: row.perms, scope: row.scope };
    if (!state) return null;
    return (
      <div className="perm-card">
        <div className={`perm-card-head role-${row.role}`}>
          <span>{PERM_ROLE_LABEL[row.role] ?? row.role}</span>
          {!editable ? <span className="perm-locked">always full access</span> : null}
        </div>
        <div className="table-wrap">
          <table className="mini perm-matrix">
            <thead>
              <tr>
                <th>Page</th>
                {cfg!.actions.map((a) => (
                  <th key={a}>{ACTION_LABEL[a] ?? a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupModules(cfg!.modules).map((g) => (
                <Fragment key={g.title}>
                  <tr className="perm-group">
                    <td colSpan={1 + cfg!.actions.length}>{g.title}</td>
                  </tr>
                  {g.modules.map((m) => (
                    <tr key={m}>
                      <td className="perm-mod">
                        {MODULE_LABEL[m] ?? m}
                        {MODULE_HINT[m] ? (
                          <span className="perm-mod-hint">{MODULE_HINT[m]}</span>
                        ) : null}
                      </td>
                      {cfg!.actions.map((a) => {
                        const na = viewOnly.has(m) && a !== "view";
                        return (
                          <td key={a} className="perm-cell">
                            {na ? (
                              <span className="perm-na">—</span>
                            ) : (
                              <input
                                type="checkbox"
                                checked={!!state.perms[m]?.[a]}
                                disabled={!editable}
                                onChange={() => toggle(row.role, m, a)}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="perm-scope">
          <span className="perm-scope-label">Data scope:</span>
          <label>
            <input
              type="radio"
              name={`scope-${row.role}`}
              checked={state.scope === "all"}
              disabled={!editable}
              onChange={() => setScope(row.role, "all")}
            />
            All deals
          </label>
          <label>
            <input
              type="radio"
              name={`scope-${row.role}`}
              checked={state.scope === "own"}
              disabled={!editable}
              onChange={() => setScope(row.role, "own")}
            />
            Own deals only
          </label>
        </div>
        {editable ? (
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={() => save(row.role)}
              disabled={savingRole === row.role}
            >
              {savingRole === row.role ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => loadInto(cfg!)} disabled={savingRole === row.role}>
              Reset
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">Role permissions</h3>
      </div>
      <p className="hint-inline" style={{ display: "block", marginBottom: 12 }}>
        Set per-page View / Create / Edit / Delete for each role, plus whether they see all deals or only their own.
        Admin always has full access. (페이지별 열람·입력·수정·삭제 권한을 역할마다 지정)
      </p>
      {msg ? <div className="action-ok" style={{ marginBottom: 10 }}>{msg}</div> : null}
      {err ? <div className="action-err" style={{ marginBottom: 10 }}>{err}</div> : null}
      <div className="perm-cards">
        {cfg.roles.map((r) => (
          <RoleCard key={r.role} row={r} />
        ))}
      </div>
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
      setErr("New passwords do not match.");
      return;
    }
    try {
      await changeMyPassword(oldPw, newPw);
      setMsg("Password changed.");
      setOldPw("");
      setNewPw("");
      setNewPw2("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Change failed");
    }
  }

  return (
    <div className="subpanel" style={{ marginTop: 20 }}>
      <div className="sub-h">Change my password{me ? ` — ${me.username}` : ""}</div>
      {/*
        진짜 <form> 으로 감싸고 계정 칸을 함께 둔다 — 모양 때문이 아니라 브라우저 때문이다.
        비밀번호 칸만 덩그러니 있으면 크롬은 '이건 로그인 폼'이라 보고 아이디 칸을 스스로
        찾아 나서는데, 이 페이지에서 그 앞의 텍스트 입력은 머리줄의 전역 검색창뿐이라
        거기에 저장된 사용자명을 채워 넣는다(그래서 Users 탭만 열면 검색창에 제 이름이
        박히고 결과 목록이 펼쳐졌다). 폼으로 울타리를 치고 autocomplete 로 각 칸이 무엇인지
        밝혀 두면, 채울 곳이 이 안에서 정해져 검색창까지 손이 뻗지 않는다.
        계정 칸은 감춰 두되 지우지는 않는다 — 비밀번호 관리자가 '어느 계정의 비밀번호가
        바뀌었는지' 알아야 저장된 항목을 갱신해 준다.
      */}
      <form
        className="form-grid"
        onSubmit={(e) => { e.preventDefault(); if (oldPw && newPw && newPw2) submit(); }}
      >
        <input type="text" name="username" autoComplete="username" value={me?.username ?? ""} readOnly hidden />
        <TextField label="Current password" value={oldPw} onChange={setOldPw} type="password" autoComplete="current-password" />
        <TextField label="New password" value={newPw} onChange={setNewPw} type="password" autoComplete="new-password" />
        <TextField label="Confirm new password" value={newPw2} onChange={setNewPw2} type="password" autoComplete="new-password" />
      </form>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={!oldPw || !newPw || !newPw2}>
          Change password
        </button>
        {err ? <span className="action-err">{err}</span> : null}
        {msg ? <span className="action-ok">{msg}</span> : null}
      </div>
    </div>
  );
}

const EMPTY_CUSTOMER: SettingsCustomer = {
  id: 0, name: "", contact: "", contact_phone: "", email: "", country: "", address: "",
  tax_id: "", tax_invoice_email: "", specialization: "", website: "", note: "", payment_terms: "", logo: "",
  addresses: [], emails: [], phones: [], regions: [],
};

/* ── Partners — 고객과 벤더를 한 번에 한 쪽씩 ─────────────────────────────────
   둘은 같은 상대처 명부를 사고 파는 방향으로만 나눈 것이라 한 탭 안에 함께 두지만,
   좌우로 반씩 나눠 놓으면 어느 쪽도 제 폭을 못 쓴다 — 취급품목이나 담당자 이름처럼
   길이가 있는 칸이 서너 줄로 접힌다. 한 번에 한 쪽만 전폭으로 보이고, 위의 알약
   전환으로 넘나든다(페이지 탭 밑의 한 급 아래 계층). */
function PartnersTab() {
  const [side, setSide] = useState<"customers" | "vendors">("customers");
  return (
    <>
      <div className="ms-party-tabs" role="tablist" aria-label="Partner type">
        {([["customers", "Customer"], ["vendors", "Vendor"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={side === key}
            className={`ms-party-tab${side === key ? " on" : ""}`}
            onClick={() => setSide(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {side === "customers" ? <CustomersTab /> : <VendorsTab />}
    </>
  );
}

function CustomersTab() {
  // 회사 공통정보 편집 대상 그룹(같은 회사명의 담당자 레코드들). null = 닫힘.
  // 회사 목록 전체와 지금 보고 있는 자리 — 창 안에서 옆 회사로 건너뛰려면 이웃을 알아야 한다.
  const [company, setCompany] = useState<
    { groups: SettingsCustomer[][]; index: number; editRow: (row: SettingsCustomer) => void } | null
  >(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canCreate = can("settings", "create");

  return (
    <>
    {company ? (
      <CompanyInfoModal
        // 회사가 바뀌면 창 안의 값도 새로 잡혀야 한다(안의 상태는 첫 렌더에 굳는다).
        key={company.groups[company.index]?.[0]?.name ?? company.index}
        rows={company.groups[company.index] ?? []}
        stats={["Inquiries → Orders", (
          <CustomerWinBadge
            inquiries={sumBy(company.groups[company.index] ?? [], (r) => r.inquiries)}
            won={sumBy(company.groups[company.index] ?? [], (r) => r.won)}
            lost={sumBy(company.groups[company.index] ?? [], (r) => r.lost)}
          />
        )]}
        {...companyNav(company, setCompany)}
        // 담당자를 고치러 갈 때는 이 창을 먼저 닫는다 — 편집 창이 그 자리에 열리므로
        // 두 창이 겹쳐 서면 어느 쪽을 닫는 손짓인지 흐려진다.
        onEditContact={(row) => { const go = company.editRow; setCompany(null); go(row); }}
        fields={[
          ["tax_id", "Tax ID / Business No."],
          ["tax_invoice_email", "Tax invoice email"],
          ["website", "Website"],
        ]}
        areas={[
          { key: "specialization", label: "Specialization", rows: 3,
            placeholder: "What they run and usually buy — bulk carriers, engine spares, deck machinery…" },
          { key: "note", label: "About this company", rows: 5,
            placeholder: "What they operate, which fleet or group they belong to, where they are based…" },
        ]}
        save={updateCustomerCompanyInfo}
        onClose={() => setCompany(null)}
        onSaved={() => {
          setReloadKey((k) => k + 1);
          invalidateCustomerLogos();
        }}
      />
    ) : null}
    <MasterSection<SettingsCustomer>
      title="Customer"
      empty={EMPTY_CUSTOMER}
      reloadKey={reloadKey}
      searchText={contactSearchText}
      group={{
        by: (r) => r.name,
        cells: (rs, open) => [
          <GroupNameCell key="n" rows={rs} open={open} />,
          <span key="r" className="ms-group-sub">{regionSummary(rs)}</span>,
          <span key="c" className="ms-group-sub">{nameSummary(rs)}</span>,
          // 회사 합계 = 담당자들의 단순 합. RFQ 는 고객 담당자 하나에만 매이므로 같은
          // 문의가 두 번 세어지지 않는다(벤더 쪽은 겹칠 수 있어 서버가 합집합을 센다).
          <CustomerWinBadge
            key="d"
            inquiries={sumBy(rs, (r) => r.inquiries)}
            won={sumBy(rs, (r) => r.won)}
            lost={sumBy(rs, (r) => r.lost)}
          />,
          <span key="s" className="ms-group-sub">
            {summarize(uniqStrings(rs.map((r) => r.specialization)), " · ", 2)}
          </span>,
        ],
        subFirst: () => <span className="ms-sub-mark">↳</span>,
        actions: (rs, addNew, nav) => (
          <>
            <button
              type="button"
              className="ms-mini"
              title="Company info — applies to all contacts of this company"
              onClick={() => setCompany(nav)}
            >
              <CompanyIcon />
            </button>
            {canCreate ? (
              <button type="button" className="ms-mini" title="Add a contact" onClick={addNew}>
                ＋
              </button>
            ) : null}
          </>
        ),
        newRow: (rs) => withCompanyDefaults(EMPTY_CUSTOMER, rs, rs[0].name),
        summary: (g, n) => `${g} companies · ${n} contacts`,
      }}
      headCols={customerHeadCols}
      load={fetchSettingsCustomers}
      create={createSettingsCustomer}
      update={updateSettingsCustomer}
      remove={deleteSettingsCustomer}
      onSaved={invalidateCustomerLogos}
      columns={[
        ["name", "Company name", (r) => (
          <span className="cust-name">
            {r.logo ? <img className="cust-logo" src={r.logo} alt="" /> : null}
            <span className="cust-name-text">{r.name || "—"}</span>
          </span>
        )],
        ["country", "Region", (r) => <MultiCell values={r.regions} flat={r.country} />],
        ["contact", "Contact"],
        ["inquiries", "Inquiries → Orders",
          (r) => (
            <CustomerWinBadge
              inquiries={r.inquiries ?? 0}
              won={r.won ?? 0}
              lost={r.lost ?? 0}
              sub
            />
          ),
          "ms-deals"],
        ["specialization", "Specialization", undefined, "ms-spec"],
      ]}
      fields={[
        ["name", "Customer *"],
        ["contact", "Contact name"],
        ["address", "Address"],
        ["specialization", "Specialization"],
        ["tax_id", "Tax ID / Business No."],
        ["tax_invoice_email", "Tax invoice email"],
      ]}
      required="name"
      topForm={(form, setForm) => (
        <BusinessCardScan
          onApply={(card) => {
            const { next, filled } = applyBusinessCard(form, card);
            setForm(next);
            return filled;
          }}
        />
      )}
      renderField={({ key, label, form, setForm, rows }) => {
        // 회사명 = 기존 등록 목록에서 고르거나(같은 회사의 다른 담당자 추가) 새로 입력.
        if (key === "name") {
          return (
            <PickOrTypeField
              label={label}
              value={form.name}
              options={uniqStrings(rows.map((r) => r.name))}
              placeholder="Select an existing customer or type a new one…"
              onChange={(v) => setForm(withCompanyDefaults(form, rows, v))}
            />
          );
        }
        // 주소 = 한 회사에 본사·지사가 여럿일 수 있어 다중값. 첫 줄(대표)이 문서에 인쇄된다.
        if (key === "address") {
          return (
            <MultiValueField
              label={label}
              placeholder="Head office / branch address"
              values={form.addresses}
              onChange={(addresses) => setForm({ ...form, addresses, address: addresses[0] ?? "" })}
            />
          );
        }
        // 사업자번호 = 같은 회사로 등록된 값 중 선택, 없으면 직접 입력.
        if (key === "tax_id") {
          const options = uniqStrings(sameCompanyRows(rows, form.name).map((r) => r.tax_id));
          return (
            <PickOrTypeField
              label={label}
              value={String(form[key] ?? "")}
              options={options}
              placeholder={options.length ? "Select or type…" : "Type…"}
              hint={
                form.name.trim() && !options.length
                  ? "No saved value for this customer — type it in."
                  : ""
              }
              onChange={(v) => setForm({ ...form, [key]: v })}
            />
          );
        }
        return null;
      }}
      extraForm={(form, setForm) => (
        <>
          <MultiValueField label="Email" placeholder="name@company.com" values={form.emails} onChange={(emails) => setForm({ ...form, emails })} />
          <MultiValueField label="Phone" placeholder="+65 1234 5678" values={form.phones} onChange={(phones) => setForm({ ...form, phones })} />
          <MultiValueField label="Region" placeholder="Singapore" values={form.regions} onChange={(regions) => setForm({ ...form, regions })} />
          <PaymentTermsField
            value={form.payment_terms}
            onChange={(payment_terms) => setForm({ ...form, payment_terms })}
          />
          <LogoPasteField
            value={form.logo}
            onChange={(logo) => setForm({ ...form, logo })}
          />
        </>
      )}
      allowCopy
      copyHint="Copies this info into a new record — keep the company, change the contact/email/region for a different person."
    />
    </>
  );
}

// 회사정보 버튼 아이콘 — 표 안에서 튀지 않게 선만 있는 단색(currentColor) 건물 모양.
function CompanyIcon() {
  return (
    <svg className="ms-icon" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M2.6 14V3.1a.6.6 0 0 1 .6-.6h6a.6.6 0 0 1 .6.6V14" />
      <path d="M9.8 6.6h3a.6.6 0 0 1 .6.6V14" />
      <path d="M1.3 14h13.4" />
      <path d="M5 5.3h2M5 7.9h2M5 10.5h2M11.2 9.2h1M11.2 11.6h1" strokeLinecap="round" />
    </svg>
  );
}

// 그룹(회사) 헤더의 첫 칸 — 펼침 화살표 + 로고 + 회사명 + 담당자 수.
function GroupNameCell({
  rows,
  open,
}: {
  rows: { name: string; logo?: string }[];
  open: boolean;
}) {
  const logo = rows.map((r) => r.logo).find((v) => v) || "";
  return (
    <span className="cust-name">
      <span className="ms-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="cust-name-text">{rows[0].name || "—"}</span>
      <span className="ms-badge">{rows.length}</span>
    </span>
  );
}

/**
 * 거래관계 배지 — 왼쪽 회색은 건수, 오른쪽은 그 결과를 색으로. Customer·Vendor 목록이
 * 같은 모양을 쓴다(두 표를 오가며 읽어도 눈이 다시 적응하지 않게).
 *
 * 색은 오른쪽에만 준다. 목록을 훑을 때 판단이 필요한 건 "몇 건 했나"가 아니라 "결과가
 * 어떤가"라서다. 이력이 없으면 0 대신 줄표다 — 0 은 '결과가 나빴다'로 잘못 읽히는데
 * 실제로는 '아직 없다'이다.
 */
function CountBadge({ total, hit, tone, title, sub = false }: {
  total: number;
  hit: number;
  tone: "all" | "mid" | "part" | "none";
  title: string;
  sub?: boolean;
}) {
  if (!total) return <span className="ms-group-sub">—</span>;
  return (
    <span className={`pt-deal${sub ? " pt-deal--sub" : ""}`} title={title}>
      <span className="pt-deal-n">{total}</span>
      <span className={`pt-stat pt-stat--${tone}`}>
        <span className="pt-stat-dot" aria-hidden />
        {hit}/{total}
      </span>
    </span>
  );
}

/** "1 inquiry" / "20 inquiries" — 복수형이 -s 가 아닌 낱말은 두 번째 인자로 준다. */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 회사 줄의 합계 — 담당자 행들의 값을 더한다(빈 값은 0). */
function sumBy<T>(rows: T[], pick: (row: T) => number | undefined): number {
  return rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
}

/**
 * 벤더 — 물어본 프로젝트 중 견적이 돌아온 몫. 답은 다 오는 것이 정상이라, 하나라도
 * 빠지면 주황이고 하나도 안 왔으면 빨강이다.
 */
function VendorReplyBadge({ total, answered, sub = false }: { total: number; answered: number; sub?: boolean }) {
  const waiting = total - answered;
  return (
    <CountBadge
      total={total}
      hit={answered}
      sub={sub}
      tone={answered === 0 ? "none" : answered < total ? "part" : "all"}
      title={`${plural(total, "project")} asked · ${answered} quoted back`
        + (waiting ? ` · ${waiting} still waiting` : "")}
    />
  );
}

/**
 * 고객 — 준 문의 중 오더로 이어진 몫, 곧 거래관계의 등급.
 *
 * 벤더와 색 규칙이 다르다. 무역에서 문의가 전부 오더가 되는 일은 없으므로 "하나라도
 * 빠지면 주황"을 그대로 쓰면 거의 모든 고객이 주황이 되어 등급 구실을 못 한다. 그래서
 * 비율로 층을 나눈다 — 절반 넘으면 초록, 4분의 1 넘으면 파랑, 그 아래는 주황, 한 건도
 * 성사된 적 없으면 빨강.
 *
 * 분모는 아직 진행 중인 문의까지 포함한 전체다(사용자가 물은 것이 "문의를 얼마나 줬고
 * 그중 얼마나 성사됐나"라서). 그래서 이 값은 최종 승률이 아니라 지금까지의 결과이며,
 * 진행 중·실주 내역은 툴팁에서 갈라 보여 준다.
 */
function CustomerWinBadge({ inquiries, won, lost, sub = false }: {
  inquiries: number; won: number; lost: number; sub?: boolean;
}) {
  const pct = inquiries ? won / inquiries : 0;
  const open = inquiries - won - lost;
  return (
    <CountBadge
      total={inquiries}
      hit={won}
      sub={sub}
      tone={won === 0 ? "none" : pct < 0.25 ? "part" : pct < 0.5 ? "mid" : "all"}
      title={`${plural(inquiries, "inquiry", "inquiries")} · `
        + `${won} became ${plural(won, "order")} (${Math.round(pct * 100)}%)`
        + (lost ? ` · ${lost} lost` : "")
        + (open > 0 ? ` · ${open} still open` : "")}
    />
  );
}

// 그룹 헤더의 지역 칸 — 담당자들의 지역을 중복 없이 모아 보여준다.
function regionSummary(rows: { regions?: string[]; country?: string }[]): string {
  const all = rows.flatMap((r) => (r.regions?.length ? r.regions : [r.country ?? ""]));
  return summarize(uniqStrings(all), " · ", 3);
}

// 그룹 헤더의 담당자 칸 — 앞 2명만 쓰고 나머지는 "+N" 으로 줄인다(행이 길어지지 않게).
function nameSummary(rows: { contact: string }[]): string {
  return summarize(uniqStrings(rows.map((r) => r.contact)), ", ", 2);
}

function summarize(list: string[], sep: string, max: number): string {
  if (!list.length) return "—";
  return list.length <= max ? list.join(sep) : `${list.slice(0, max).join(sep)} +${list.length - max}`;
}

// 검색 대상 — 표에 접혀 있는 값(2번째 이메일·전화·주소)까지 포함해 찾을 수 있게 한다.
function contactSearchText(r: {
  name: string; contact: string; address?: string; specialization?: string; note?: string;
  addresses?: string[]; emails?: string[]; phones?: string[]; regions?: string[];
  email?: string; contact_phone?: string; country?: string;
}): string {
  return [
    r.name, r.contact, r.address ?? "", r.specialization ?? "", r.note ?? "",
    ...(r.addresses ?? []), ...(r.emails ?? []), ...(r.phones ?? []), ...(r.regions ?? []),
    r.email ?? "", r.contact_phone ?? "", r.country ?? "",
  ].join(" ");
}

// 회사 공통정보 일괄 수정 — 같은 회사명으로 등록된 담당자 레코드 전체에 한 번에 반영한다.
// (주소·사업자번호 같은 회사 단위 정보가 레코드마다 복제돼 있어 따로 고치면 어긋난다.)
/** Company info 창의 전폭 여러 줄 칸 하나. */
type CompanyArea<T> = {
  key: keyof T & keyof CompanyInfoSave;
  label: string;
  rows?: number;
  placeholder?: string;
};

/**
 * 담당자 한 명의 이메일·연락처·지역 — 다중값이 있으면 그것, 없으면 대표값 하나.
 * 목록의 칸에서는 "+N" 으로 접지만 이 창은 확인하러 오는 자리라 전부 펼친다.
 */
function contactValues(multi: string[] | undefined, flat: string | undefined): string[] {
  const src = multi?.length ? multi : [flat ?? ""];
  return src.map((v) => (v ?? "").trim()).filter(Boolean);
}

/** 회사 정보 창이 옆 회사로 건너뛸 때 쓰는 한 걸음 — 어디로 가는지(name)와 가는 법(go). */
type CompanyNav = { name: string; go: () => void };

/** 회사 목록에서 앞뒤 한 걸음을 만든다(두 탭이 같은 모양으로 쓴다). */
function companyNav<T extends { name: string }, S extends { groups: T[][]; index: number }>(
  st: S,
  set: (s: S) => void,
): { prev?: CompanyNav; next?: CompanyNav } {
  const nameAt = (i: number) => st.groups[i]?.[0]?.name ?? "";
  return {
    prev: st.index > 0
      ? { name: nameAt(st.index - 1), go: () => set({ ...st, index: st.index - 1 }) } : undefined,
    next: st.index < st.groups.length - 1
      ? { name: nameAt(st.index + 1), go: () => set({ ...st, index: st.index + 1 }) } : undefined,
  };
}

function CompanyInfoModal<
  T extends {
    id: number; name: string; address: string; addresses: string[];
    payment_terms: string; logo: string;
    // 담당자 명단을 창 안에서 함께 읽는다 — 고객·거래선 두 표가 같은 칸을 갖고 있다.
    contact: string; email: string; contact_phone: string;
    emails: string[]; phones: string[]; regions: string[]; country: string;
  }
>({
  rows,
  fields,
  areas,
  save,
  onClose,
  onSaved,
  stats,
  prev,
  next,
  onEditContact,
}: {
  rows: T[];
  fields: [keyof T & keyof CompanyInfoSave, string][];
  /** 문장으로 적는 칸(취급품목·회사 소개) — 한 줄 칸에 넣으면 앞머리만 보여 값을 확인하려면
      캐럿을 끝까지 밀어야 한다. 폼 아래에 전폭 여러 줄 칸으로 따로 세운다. */
  areas?: CompanyArea<T>[];
  save: (body: CompanyInfoSave) => Promise<{ ok: boolean; updated: number }>;
  onClose: () => void;
  onSaved: () => void;
  /** 이 회사와의 거래 요약(문의·수주 / 프로젝트·회신) — 표에 선 배지를 그대로 들여온다. */
  stats?: [string, ReactNode];
  /** 표의 앞뒤 회사로 건너뛰기. 이름을 함께 받아 어디로 가는지 미리 보인다. */
  prev?: CompanyNav;
  next?: CompanyNav;
  /** 담당자 한 명을 고치러 간다(바깥 목록의 편집 창을 연다). 없으면 단추도 없다. */
  onEditContact?: (row: T) => void;
}) {
  // 저장 뒤에도 창이 남으므로 회사명을 상태로 든다. 이름을 바꿔 저장하면 제목·읽기
  // 화면이 새 이름이 되어야 하고, 그 다음 저장의 조회 키도 새 이름이어야 한다.
  const [baseName, setBaseName] = useState(rows[0].name);
  const origName = baseName;
  // 각 필드의 시작값 = 등록된 값 중 첫 번째(비어 있지 않은 것).
  const initial = (key: keyof T) => uniqStrings(rows.map((r) => String(r[key] ?? "")))[0] ?? "";
  const [name, setName] = useState(origName);
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = { payment_terms: initial("payment_terms" as keyof T), logo: initial("logo" as keyof T) };
    for (const [key] of fields) out[String(key)] = initial(key as keyof T);
    for (const a of areas ?? []) out[String(a.key)] = initial(a.key as keyof T);
    return out;
  });
  // 주소는 회사 단위 다중값(본사·지사) — 담당자별로 갈라져 있어도 여기서 한 목록으로 모은다.
  const [addresses, setAddresses] = useState<string[]>(() => companyAddresses(rows));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 열면 읽기부터 — 이 창은 대개 "이 회사가 뭐 하는 곳이었지"를 확인하러 연다. 곧장
  // 입력칸으로 열어 두면 확인하러 들어왔다가 잘못 눌러 회사 전 담당자의 값을 한꺼번에
  // 바꾸는 일이 생긴다(이 창의 저장은 한 명이 아니라 회사 전체에 닿는다).
  const [editing, setEditing] = useState(false);
  const canEditCompany = can("settings", "edit");

  // 담당자별로 값이 다른 필드 — 저장하면 하나로 통일된다는 걸 미리 알린다.
  const mixed = [...fields, ["payment_terms", "Payment terms"] as (typeof fields)[number],
                 ...(areas ?? []).map((a) => [a.key, a.label] as (typeof fields)[number])]
    .filter(([k]) => uniqStrings(rows.map((r) => String(r[k as keyof T] ?? ""))).length > 1)
    .map(([, label]) => label);

  // 읽는 중에는 ←→ 로도 옆 회사로 넘어간다. 편집 중에는 걸지 않는다 — 칸에 글자를
  // 치는 중이라 커서를 옮기려던 손짓이 창을 통째로 바꿔 버린다.
  useEffect(() => {
    if (editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev?.go();
      else if (e.key === "ArrowRight") next?.go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, prev, next]);

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const body: CompanyInfoSave = { name: origName, ...vals, addresses };
      if (name.trim() && name.trim() !== origName) body.rename = name.trim();
      await save(body);
      // 저장하면 읽기로 돌아온다 — 창을 닫아 버리면 방금 무엇을 저장했는지 확인할
      // 자리가 없고, 이어서 옆 회사로 넘어가려면 목록에서 그 회사를 다시 찾아야 한다.
      setBaseName(name.trim() || origName);
      setEditing(false);
      setBusy(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  if (!editing) {
    const shown: [string, React.ReactNode][] = [
      ["Company name", origName],
      ["Address", addresses.length
        ? <span className="co-lines">{addresses.map((a, i) => <span key={i}>{a}</span>)}</span>
        : null],
      ...fields.map(([key, label]) => {
        const v = vals[String(key)] ?? "";
        // 홈페이지는 눌러서 갈 수 있어야 쓸모가 있다 — 주소 앞머리를 빼먹고 적는 일이
        // 흔해서, 없으면 붙여서 연다.
        const node = !v ? null : String(key) === "website"
          ? <a href={/^https?:\/\//i.test(v) ? v : `https://${v}`} target="_blank" rel="noreferrer">{v}</a>
          : v;
        return [label, node] as [string, React.ReactNode];
      }),
      ["Payment terms", vals.payment_terms || null],
      ...(stats ? [stats] : []),
      ...(areas ?? []).map((a) => [a.label, vals[String(a.key)]
        ? <span className="co-para">{vals[String(a.key)]}</span> : null] as [string, React.ReactNode]),
    ];
    return (
      <Modal title={`🏢 Company info — ${origName}`} onClose={onClose} form>
        {prev || next ? (
          <div className="co-nav">
            <button type="button" className="btn tiny" disabled={!prev}
                    onClick={() => prev?.go()} title={prev ? `← ${prev.name}` : ""}>
              ◀ {prev ? prev.name : "—"}
            </button>
            <button type="button" className="btn tiny" disabled={!next}
                    onClick={() => next?.go()} title={next ? `${next.name} →` : ""}>
              {next ? next.name : "—"} ▶
            </button>
          </div>
        ) : null}
        <div className="company-read">
          {vals.logo ? <img className="co-logo" src={vals.logo} alt="" /> : null}
          <dl>
            {shown.map(([label, node]) => (
              <div key={label} className="co-row">
                <dt>{label}</dt>
                <dd>{node ?? <span className="dash">—</span>}</dd>
              </div>
            ))}
          </dl>
          {/* 담당자 명단 — 위 값들이 회사 단위인 데 반해 이쪽은 사람마다 다른 값이라,
              같은 표에 섞지 않고 아래에 따로 세운다. 고치는 자리는 바깥 목록이다. */}
          <div className="co-contacts">
            <div className="co-contacts-hd">
              Contacts<span className="ms-badge">{rows.length}</span>
            </div>
            <table className="mini">
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Phone</th><th>Region</th>
                  {onEditContact ? <th className="co-edit-col" /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const mails = contactValues(r.emails, r.email);
                  const tels = contactValues(r.phones, r.contact_phone);
                  const regions = contactValues(r.regions, r.country);
                  return (
                    <tr key={r.id}>
                      <td>{r.contact || <span className="dash">—</span>}</td>
                      <td>
                        {mails.length ? (
                          <span className="co-lines">
                            {mails.map((m) => <a key={m} href={`mailto:${m}`}>{m}</a>)}
                          </span>
                        ) : <span className="dash">—</span>}
                      </td>
                      <td>
                        {tels.length
                          ? <span className="co-lines">{tels.map((t) => <span key={t}>{t}</span>)}</span>
                          : <span className="dash">—</span>}
                      </td>
                      <td>{regions.join(" · ") || <span className="dash">—</span>}</td>
                      {onEditContact ? (
                        <td className="co-edit-col">
                          <button
                            type="button"
                            className="btn tiny"
                            onClick={() => onEditContact(r)}
                            title={`Edit ${r.contact || "this contact"}`}
                          >
                            ✎
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
            The values above are company-level — editing them applies to all {rows.length} contacts
            at once. Contacts themselves are edited from the list behind this dialog.
          </p>
        </div>
        <div className="form-actions">
          {canEditCompany ? (
            <button className="btn primary" onClick={() => setEditing(true)}>✎ Edit</button>
          ) : null}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`🏢 Company info — ${origName}`} onClose={onClose} form>
      <div className="ms-copy-hint">
        Applies to all {rows.length} contacts of this company at once.
        {mixed.length ? ` Currently different per contact: ${mixed.join(", ")} — saving will make them the same.` : ""}
      </div>
      <div className="form-grid">
        <TextField label="Company name" value={name} onChange={setName} />
        <MultiValueField
          label="Address"
          placeholder="Head office / branch address"
          values={addresses}
          onChange={setAddresses}
        />
        {fields.map(([key, label]) => (
          <TextField
            key={String(key)}
            label={label}
            value={vals[String(key)] ?? ""}
            onChange={(v) => setVals({ ...vals, [String(key)]: v })}
          />
        ))}
        <PaymentTermsField
          value={vals.payment_terms ?? ""}
          onChange={(v) => setVals({ ...vals, payment_terms: v })}
        />
        <LogoPasteField value={vals.logo ?? ""} onChange={(v) => setVals({ ...vals, logo: v })} />
        {(areas ?? []).map((a) => (
          <label key={String(a.key)} className="form-field company-area-field">
            <span>{a.label}</span>
            <textarea
              rows={a.rows ?? 4}
              placeholder={a.placeholder ?? ""}
              value={vals[String(a.key)] ?? ""}
              onChange={(e) => setVals({ ...vals, [String(a.key)]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : `Save to ${rows.length} contacts`}
        </button>
        {/* 고치다 그만두는 것과 창을 닫는 것은 다른 일이다 — 확인하러 온 김에 잠깐
            고쳐 보다 그만두면 읽기로 돌아오는 편이 자연스럽다. */}
        <button className="btn" onClick={() => { setEditing(false); setErr(""); }}>Cancel</button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}

// 기존 등록값 중에서 고르거나(토글) 목록에 없으면 직접 입력하는 필드.
function PickOrTypeField({
  label,
  value,
  options,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="form-field">
      <label>{label}</label>
      <ComboBox value={value ?? ""} onChange={onChange} options={options} placeholder={placeholder} />
      {hint ? <span className="hint-inline">{hint}</span> : null}
    </div>
  );
}

// 공백·중복(대소문자 무시) 제거한 선택지 목록.
function uniqStrings(values: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = (v ?? "").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

// 같은 회사명으로 등록된 레코드들(레코드 1건 = 담당자 1명이라 회사당 여러 행이 있다).
function sameCompanyRows<T extends { name: string }>(rows: T[], name: string): T[] {
  const key = (name || "").trim().toLowerCase();
  if (!key) return [];
  return rows.filter((r) => (r.name || "").trim().toLowerCase() === key);
}

// 회사명을 기존 목록에서 고르면(=정확히 일치하면) 그 회사에 등록된 공통 정보를
// 빈 칸에 한해 자동으로 채운다. 이미 입력한 값은 건드리지 않는다.
function withCompanyDefaults<T extends { name: string }>(form: T, rows: T[], name: string): T {
  const rec = { ...form, name } as Record<string, unknown>;
  const mates = sameCompanyRows(rows, name);
  if (!mates.length) return rec as unknown as T;
  // 회사 단위 값 — 같은 회사에 담당자를 하나 더 넣을 때 회사 소개·결제조건까지 물려준다.
  for (const key of ["tax_id", "tax_invoice_email", "payment_terms", "logo", "specialization", "note"]) {
    if (!(key in rec) || String(rec[key] ?? "").trim()) continue;
    const first = uniqStrings(mates.map((r) => String((r as Record<string, unknown>)[key] ?? "")))[0];
    if (first) rec[key] = first;
  }
  // 주소는 회사 단위 정보(본사·지사) — 등록된 곳 전부를 그대로 물려준다.
  if ("addresses" in rec && !((rec.addresses as string[]) ?? []).length) {
    const list = companyAddresses(mates as { name: string; addresses?: string[]; address?: string }[]);
    if (list.length) {
      rec.addresses = list;
      rec.address = list[0];
    }
  }
  return rec as unknown as T;
}

// 회사에 등록된 주소 전부(담당자 레코드마다 복제돼 있으므로 합쳐서 중복 제거).
function companyAddresses(rows: { addresses?: string[]; address?: string }[]): string[] {
  return uniqStrings(rows.flatMap((r) => (r.addresses?.length ? r.addresses : [r.address ?? ""])));
}

// 명함 인식 결과를 폼에 반영 — 빈 칸만 채우고, 이메일·연락처·지역은 없는 값만 추가한다.
// 반환값 filled = 실제로 채워진 항목 라벨(사용자에게 무엇이 들어갔는지 보여주기 위함).
function applyBusinessCard<
  T extends {
    name: string; contact: string; address: string;
    addresses: string[]; emails: string[]; phones: string[]; regions: string[];
  }
>(form: T, card: BusinessCardOcr): { next: T; filled: string[] } {
  const rec = { ...form } as Record<string, unknown>;
  const filled: string[] = [];

  function text(key: string, label: string, value?: string) {
    const v = (value ?? "").trim();
    if (!v || !(key in rec) || String(rec[key] ?? "").trim()) return;
    rec[key] = v;
    filled.push(label);
  }
  function multi(key: string, label: string, values?: string[]) {
    const cur = ((rec[key] as string[]) ?? []).filter((v) => v.trim());
    const add = uniqStrings(values ?? []).filter(
      (v) => !cur.some((c) => c.trim().toLowerCase() === v.toLowerCase())
    );
    if (!add.length) return;
    rec[key] = [...cur, ...add];
    filled.push(label);
  }

  text("name", "Company", card.company);
  text("contact", "Contact name", card.contact_name);
  text("tax_id", "Tax ID", card.tax_id);
  // 명함의 주소는 그 담당자가 있는 곳 — 이미 등록된 본사·지사 목록에 없을 때만 덧붙인다.
  multi("addresses", "Address", card.address ? [card.address] : []);
  rec.address = ((rec.addresses as string[]) ?? [])[0] ?? "";
  multi("emails", "Email", card.emails);
  multi("phones", "Phone", card.phones);
  multi("regions", "Region", card.regions);

  return { next: rec as unknown as T, filled };
}

// 명함 스캔 패널 — 사진을 붙여넣거나(Ctrl+V) 파일을 고르면 Claude 비전이 읽어
// 회사·담당자·주소·사업자번호·이메일·연락처를 아래 입력칸에 채워 준다.
function BusinessCardScan({ onApply }: { onApply: (card: BusinessCardOcr) => string[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [filled, setFilled] = useState<string[]>([]);
  const [preview, setPreview] = useState("");

  async function scan(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr("");
    setFilled([]);
    try {
      if (file.type.startsWith("image/")) {
        setPreview(await fileToLogoDataUrl(file, 320).catch(() => ""));
      } else {
        setPreview("");
      }
      const card = await parseBusinessCard(await downscaleImageFile(file));
      const applied = onApply(card);
      setFilled(applied);
      if (!applied.length) {
        setErr("명함에서 새로 채울 내용을 찾지 못했습니다(이미 입력된 칸은 덮어쓰지 않습니다).");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "명함 인식 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bc-scan">
      <div className="bc-scan-head">
        <span className="bc-scan-title">📇 Scan business card</span>
        <span className="hint-inline">
          명함 사진을 붙여넣거나(Ctrl+V) 파일을 고르면 아래 칸이 자동으로 채워집니다 — 비어 있는 칸만
          채우고, 이메일·연락처는 없는 값만 추가합니다.
        </span>
      </div>
      <div
        className="logo-drop bc-drop"
        tabIndex={0}
        onPaste={(e) => {
          const img = imageFromClipboard(e);
          if (img) {
            e.preventDefault();
            scan(img);
          }
        }}
      >
        {preview ? (
          <img className="bc-preview" src={preview} alt="business card" />
        ) : (
          <span className="logo-hint">Click here and paste (Ctrl+V), or choose a photo / PDF</span>
        )}
      </div>
      <div className="logo-actions">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          disabled={busy}
          onChange={(e) => {
            scan(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        {busy ? <span className="hint-inline">Reading card…</span> : null}
        {filled.length ? <span className="action-ok">Filled: {filled.join(", ")}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

// 목록 셀 — 대표(첫 값) + 추가 개수(예: "a@x.com +1"). 리스트가 비면 flat 값 표시.
function MultiCell({ values, flat }: { values?: string[]; flat: string }) {
  const list = (values ?? []).filter(Boolean);
  const first = list[0] || flat || "—";
  const extra = list.length > 1 ? list.length - 1 : 0;
  return (
    <span>
      {first}
      {extra > 0 ? <span className="mv-more"> +{extra}</span> : null}
    </span>
  );
}

// 다중값 입력(이메일·연락처·지역 등) — 값 여러 개를 추가·삭제. 맨 위 = 대표(문서·메일용).
function MultiValueField({
  label,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  placeholder?: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const list = values.length ? values : [""];
  function set(i: number, v: string) {
    onChange(list.map((x, idx) => (idx === i ? v : x)));
  }
  function add() {
    onChange([...list, ""]);
  }
  function remove(i: number) {
    const next = list.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [""]);
  }
  return (
    <div className="form-field mv-field">
      <span>{label} <span className="mv-hint">(multiple — top one is primary)</span></span>
      <div className="mv-list">
        {list.map((v, i) => (
          <div key={i} className="mv-row">
            <input className="mv-in" placeholder={placeholder} value={v} onChange={(e) => set(i, e.target.value)} />
            {i === 0 ? <span className="mv-primary" title="Used on documents & emails">Primary</span> : null}
            {list.length > 1 ? (
              <button type="button" className="btn sm danger mv-del" onClick={() => remove(i)} title="Remove">✕</button>
            ) : null}
          </div>
        ))}
      </div>
      <button type="button" className="btn sm mv-add" onClick={add}>+ Add {label.toLowerCase()}</button>
    </div>
  );
}

// 기본 결제조건 콤보박스 — 추천 목록에서 선택하거나 직접 입력. 여기 등록한 값이
// 3·4단계 견적 상세편집의 Payment Terms 기본값으로 불려온다.
function PaymentTermsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="form-field">
      <label>Payment Terms</label>
      <ComboBox
        value={value ?? ""}
        onChange={onChange}
        options={PAYMENT_TERMS_PRESETS}
        placeholder="Select or type…"
      />
    </div>
  );
}

// 회사 로고 붙여넣기 필드 — 캡쳐본을 Ctrl+V 로 붙이거나 파일 선택으로 등록.
// 이미지는 96px 로 축소한 data URL 로 저장된다.
function LogoPasteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function useFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      onChange(await fileToLogoDataUrl(file));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Image error");
    } finally {
      setBusy(false);
    }
  }

  return (
    // 바깥을 <label> 로 두면 로고 박스·캡션 등 아무 데나 클릭해도 파일창이 열린다.
    // <div> 로 바꿔, 파일창은 "파일 선택" 버튼(파일 input)에서만 열리게 한다.
    // 로고 박스 클릭은 붙여넣기(Ctrl+V)를 위한 포커스 용도로만 동작.
    <div className="form-field logo-field">
      <span>Company logo</span>
      <div
        className="logo-drop"
        tabIndex={0}
        onPaste={(e) => {
          const img = imageFromClipboard(e);
          if (img) {
            e.preventDefault();
            useFile(img);
          }
        }}
      >
        {value ? (
          <img className="logo-preview" src={value} alt="logo" />
        ) : (
          <span className="logo-hint">Click here and paste (Ctrl+V), or choose a file</span>
        )}
      </div>
      <div className="logo-actions">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={(e) => useFile(e.target.files?.[0] ?? null)}
        />
        {value ? (
          <button type="button" className="btn" onClick={() => onChange("")}>
            Remove
          </button>
        ) : null}
        {busy ? <span className="hint-inline">Processing…</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

const EMPTY_VENDOR: SettingsVendor = {
  id: 0, name: "", contact: "", contact_phone: "", email: "", specialization: "", website: "", note: "",
  country: "", address: "", payment_terms: "", logo: "",
  addresses: [], emails: [], phones: [], regions: [],
};

function VendorsTab() {
  const [company, setCompany] = useState<
    { groups: SettingsVendor[][]; index: number; editRow: (row: SettingsVendor) => void } | null
  >(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canCreate = can("settings", "create");

  return (
    <>
    {company ? (
      <CompanyInfoModal
        key={company.groups[company.index]?.[0]?.name ?? company.index}
        rows={company.groups[company.index] ?? []}
        stats={["Projects → Quoted back", (
          <VendorReplyBadge
            total={company.groups[company.index]?.[0]?.co_deals ?? 0}
            answered={company.groups[company.index]?.[0]?.co_deals_answered ?? 0}
          />
        )]}
        {...companyNav(company, setCompany)}
        onEditContact={(row) => { const go = company.editRow; setCompany(null); go(row); }}
        fields={[["website", "Website"]]}
        areas={[
          { key: "specialization", label: "Specialization", rows: 3,
            placeholder: "Engine spares, hydraulics, deck machinery…" },
          { key: "note", label: "About this company", rows: 5,
            placeholder: "What they make or represent, which brands they carry, where they are based…" },
        ]}
        save={updateVendorCompanyInfo}
        onClose={() => setCompany(null)}
        onSaved={() => {
          setReloadKey((k) => k + 1);
          invalidateVendorLogos();
        }}
      />
    ) : null}
    <MasterSection<SettingsVendor>
      title="Vendor"
      empty={EMPTY_VENDOR}
      reloadKey={reloadKey}
      searchText={contactSearchText}
      group={{
        by: (r) => r.name,
        cells: (rs, open) => [
          <GroupNameCell key="n" rows={rs} open={open} />,
          <span key="r" className="ms-group-sub">{regionSummary(rs)}</span>,
          <span key="c" className="ms-group-sub">{nameSummary(rs)}</span>,
          <VendorReplyBadge key="d" total={rs[0].co_deals ?? 0} answered={rs[0].co_deals_answered ?? 0} />,
          <span key="s" className="ms-group-sub">
            {summarize(uniqStrings(rs.map((r) => r.specialization)), " · ", 2)}
          </span>,
        ],
        subFirst: () => <span className="ms-sub-mark">↳</span>,
        actions: (rs, addNew, nav) => (
          <>
            <button
              type="button"
              className="ms-mini"
              title="Company info — applies to all contacts of this company"
              onClick={() => setCompany(nav)}
            >
              <CompanyIcon />
            </button>
            {canCreate ? (
              <button type="button" className="ms-mini" title="Add a contact" onClick={addNew}>
                ＋
              </button>
            ) : null}
          </>
        ),
        newRow: (rs) => withCompanyDefaults(EMPTY_VENDOR, rs, rs[0].name),
        summary: (g, n) => `${g} vendors · ${n} contacts`,
      }}
      headCols={vendorHeadCols}
      load={fetchSettingsVendors}
      create={createSettingsVendor}
      update={updateSettingsVendor}
      remove={deleteSettingsVendor}
      onSaved={invalidateVendorLogos}
      columns={[
        ["name", "Company name", (r) => (
          <span className="cust-name">
            {r.logo ? <img className="cust-logo" src={r.logo} alt="" /> : null}
            <span className="cust-name-text">{r.name || "—"}</span>
          </span>
        )],
        ["country", "Region", (r) => <MultiCell values={r.regions} flat={r.country} />],
        ["contact", "Contact"],
        // 담당자 줄은 그 담당자 몫만 — 회사 합계는 위 그룹 줄이 든다.
        ["deals", "Projects",
          (r) => <VendorReplyBadge total={r.deals ?? 0} answered={r.deals_answered ?? 0} sub />,
          "ms-deals"],
        ["specialization", "Specialization", undefined, "ms-spec"],
      ]}
      fields={[
        ["name", "Vendor *"],
        ["contact", "Contact name"],
        ["address", "Address"],
        ["specialization", "Specialization"],
      ]}
      required="name"
      topForm={(form, setForm) => (
        <BusinessCardScan
          onApply={(card) => {
            const { next, filled } = applyBusinessCard(form, card);
            setForm(next);
            return filled;
          }}
        />
      )}
      renderField={({ key, label, form, setForm, rows }) => {
        if (key === "name") {
          return (
            <PickOrTypeField
              label={label}
              value={form.name}
              options={uniqStrings(rows.map((r) => r.name))}
              placeholder="Select an existing vendor or type a new one…"
              onChange={(v) => setForm(withCompanyDefaults(form, rows, v))}
            />
          );
        }
        // 주소 = 본사·지사가 여럿일 수 있어 다중값. 첫 줄(대표)이 문서에 인쇄된다.
        if (key === "address") {
          return (
            <MultiValueField
              label={label}
              placeholder="Head office / branch address"
              values={form.addresses}
              onChange={(addresses) => setForm({ ...form, addresses, address: addresses[0] ?? "" })}
            />
          );
        }
        return null;
      }}
      extraForm={(form, setForm) => (
        <>
          <MultiValueField label="Email" placeholder="name@company.com" values={form.emails} onChange={(emails) => setForm({ ...form, emails })} />
          <MultiValueField label="Phone" placeholder="+65 1234 5678" values={form.phones} onChange={(phones) => setForm({ ...form, phones })} />
          <MultiValueField label="Region" placeholder="Singapore" values={form.regions} onChange={(regions) => setForm({ ...form, regions })} />
          <PaymentTermsField
            value={form.payment_terms}
            onChange={(payment_terms) => setForm({ ...form, payment_terms })}
          />
          <LogoPasteField
            value={form.logo}
            onChange={(logo) => setForm({ ...form, logo })}
          />
        </>
      )}
      allowCopy
      copyHint="Copies this info into a new record — keep the company, change the contact/email/region for a different person."
    />
    </>
  );
}

function VesselsTab() {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    fetchCustomers().then(setCustomers).catch(() => setCustomers([]));
  }, []);

  return (
    <MasterSection<SettingsVessel>
      title="Vessel Management"
      // 한 줄에 다섯 칸뿐이라 넓은 화면에서는 표 오른쪽이 통째로 비고 목록만 길어진다 —
      // 좌우 2열로 나눠 그 빈칸을 목록의 뒷부분으로 채운다(고객·거래선 표와 같은 규칙).
      twoCol
      // 칸마다 값이 한 낱말(IMO·선종·선적·고객)이라, 남는 폭을 이름 칸에 몰아주는 기본
      // 배분은 이 표에 맞지 않는다 — 칸마다 내용에 비례해 나눠 갖게 한다.
      tableClass="ms-table--even"
      headCols={vesselHeadCols}
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
        ["vessel_type", "Vessel type"],
        ["ais_flag", "AIS Flag"],
        ["customer", "Customer"],
      ]}
      fields={[
        ["name", "Vessel *"],
        ["imo", "IMO No."],
        ["ais_flag", "AIS Flag (flag state)"],
        ["engine_type", "Main Engine Type"],
        ["hull_no", "Hull No."],
      ]}
      required="name"
      extraForm={(form, setForm) => (
        <>
          <label className="form-field">
            <span>Vessel type</span>
            <input
              list="vessel-type-list"
              value={form.vessel_type ?? ""}
              onChange={(e) => setForm({ ...form, vessel_type: e.target.value })}
              placeholder="Select or type"
            />
            <datalist id="vessel-type-list">
              {VESSEL_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="form-field">
            <span>Owner Customer</span>
            <select
              value={form.customer_id ?? ""}
              onChange={(e) => setForm({ ...form, customer_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">None</option>
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

/**
 * Consultant — 딜을 물어다 준 사람과, 그에게 수수료를 보낼 계좌.
 *
 * 고객·거래선 탭과 같은 모양이되 담는 것이 다르다. 여기 적힌 값은 대부분 지급하는 순간에만
 * 쓰인다 — 그래서 목록에 세우는 다섯 칸은 연락처가 아니라 '얼마를(요율) 어디로(계좌)'다.
 * 요율은 이 사람의 기본값이고, 딜마다 다르게 정한 값은 프로젝트 1단계가 들고 있다.
 */
function ConsultantsTab() {
  return (
    <MasterSection<SettingsConsultant>
      title="Consultant Management"
      twoCol
      tableClass="ms-table--even"
      empty={{
        id: 0, name: "", company: "", phone: "", email: "", country: "", tax_id: "",
        bank_name: "", bank_account: "", bank_holder: "", swift: "",
        default_rate: 10, currency: "KRW", notes: "",
      }}
      load={fetchSettingsConsultants}
      create={createSettingsConsultant}
      update={updateSettingsConsultant}
      remove={deleteSettingsConsultant}
      columns={[
        ["name", "Consultant"],
        ["company", "Company"],
        ["default_rate", "Fee rate", (r) => `${r.default_rate}%`],
        ["bank_name", "Bank", (r) => (r.bank_account
          ? <span>{r.bank_name} <span className="muted">{r.bank_account}</span></span>
          : <span className="dash">Not registered</span>)],
        ["currency", "Account"],
      ]}
      fields={[
        ["name", "Consultant *"],
        ["company", "Company"],
        ["phone", "Phone"],
        ["email", "Email"],
        ["country", "Country / region"],
        ["tax_id", "Business / ID no."],
        ["bank_name", "Bank"],
        ["bank_account", "Account no."],
        ["bank_holder", "Account holder"],
        ["swift", "SWIFT (overseas)"],
      ]}
      required="name"
      searchText={(r) => [r.name, r.company, r.email, r.phone, r.bank_name, r.bank_account].join(" ")}
      extraForm={(form, setForm) => (
        <>
          <label className="form-field">
            {/* 딜에서 따로 정하지 않으면 이 값이 그대로 수수료율이 된다. */}
            <span>Default fee rate (% of sales)</span>
            <input
              className="num"
              inputMode="decimal"
              value={String(form.default_rate ?? "")}
              onChange={(e) => setForm({ ...form, default_rate: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="form-field">
            {/* 지급 통화를 정하는 칸이 아니다 — 수수료는 그 딜을 판 통화 그대로 나간다
                (달러로 받은 돈에서 떼어 달러로 보낸다). 여기 적는 건 이 사람이 어떤 계좌를
                가졌는가라는 사실이고, 달러 딜 수수료를 보내기 전에 확인할 값이다. */}
            <span>Account currency</span>
            <select value={form.currency || "KRW"} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="KRW">KRW ₩</option>
              <option value="USD">USD $</option>
            </select>
            <span className="hint-inline">
              For reference — a fee is paid in the currency its project sold in.
            </span>
          </label>
          <label className="form-field" style={{ gridColumn: "1 / -1" }}>
            <span>Notes</span>
            <textarea rows={2} value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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

// 품목 마스터는 물품(Parts)과 용역(Service)을 한 표에 섞어 두면 서로의 빈칸만 는다 —
// 용역엔 품번·원산지·HS 코드가 없고, 물품엔 그런 칸이 다 필요하다. 그래서 같은 마스터를
// item_type 으로 갈라 탭 하나씩 준다. 탭마다 보여 줄 칸과 입력 칸이 다르다.
export type ItemKind = "part" | "service";

const ITEM_KIND_LABEL: Record<ItemKind, string> = { part: "Parts", service: "Service" };

/** 품목이 등장한 딜의 프로젝트 번호(최근 순). 옛 응답(필드 없음)도 견디게 한다. */
function itemProjects(r: SettingsItem): string[] {
  return r.project_nos?.length ? r.project_nos : r.project_no ? [r.project_no] : [];
}
// 딜의 결말 — 배지 글자와 줄 세우는 순서(문의 → 견적 → 수주 → 결제, 종결은 끝).
const DEAL_LABEL: Record<string, string> = {
  open: "Open", quoted: "Quoted", ordered: "Ordered", paid: "Paid", closed: "Closed",
};
const DEAL_RANK: Record<string, number> = {
  open: 1, quoted: 2, ordered: 3, paid: 4, closed: 5,
};

/** 품목이 들어간 선박(최근 순). 같은 규칙. */
function itemVessels(r: SettingsItem): string[] {
  return r.vessels?.length ? r.vessels : r.vessel ? [r.vessel] : [];
}

/** 값이 여럿인 칸 — 대표(가장 최근) 하나만 세우고 나머지는 "+N"(툴팁에 전체 목록).
 *  칸을 늘리지 않으면서 "이 품목은 딜/배가 하나가 아니다"를 알리는 최소한의 표시다. */
function multiCell(all: string[], render?: (v: string) => React.ReactNode): React.ReactNode {
  if (!all.length) return <span className="dash">—</span>;
  return (
    <span className="ms-multi">
      {render ? render(all[0]) : all[0]}
      {all.length > 1
        ? <span className="ms-multi-more" title={all.join(", ")}>+{all.length - 1}</span>
        : null}
    </span>
  );
}

/**
 * 선박 목록의 머리 칸 규칙.
 *
 * 이름과 IMO 는 배마다 다른 값이라 고르는 목록으로 만들면 행 수만큼 긴 메뉴가 된다 —
 * 정렬만 둔다. 선종·선적·고객은 값이 몇 가지로 모이므로 골라서 거를 수 있게 한다.
 * 두 열로 잘라 그리는 표지만, 자르는 것은 이미 거르고 정렬한 뒤라 그대로 맞물린다.
 */
const vesselHeadCols: HeadCol<SettingsVessel>[] = [
  { key: "name", text: (r) => r.name || "" },
  { key: "imo", text: (r) => r.imo || "", emptyLabel: "No IMO" },
  { key: "vessel_type", text: (r) => r.vessel_type || "", filter: "facet",
    emptyLabel: "Unspecified" },
  { key: "ais_flag", text: (r) => r.ais_flag || "", filter: "facet", emptyLabel: "Unspecified" },
  { key: "customer", text: (r) => r.customer || "", filter: "facet", emptyLabel: "No customer" },
];

/** 담당자 한 명이 여러 지역을 가질 수 있다 — 패싯 판정은 그 전부로 한다. */
const partyRegions = (r: { regions?: string[]; country?: string }): string[] =>
  (r.regions?.length ? r.regions : [r.country ?? ""]).filter((v) => v !== undefined);

/**
 * 거래관계 배지 열의 패싯 값 — 숫자가 아니라 상태로 고른다.
 *
 * 건수로 목록을 만들면 "1", "2", "19" 가 늘어설 뿐이고, 정작 찾고 싶은 것은
 * "답이 한 번도 안 온 벤더"·"한 건도 성사 안 된 고객"이다. 정렬은 건수로 하고
 * (sortValue), 고르는 목록은 이 상태 이름으로 낸다.
 */
function relationState(total: number, hit: number, kind: "reply" | "win"): string {
  if (!total) return "";
  if (hit === 0) return kind === "reply" ? "No reply yet" : "Never ordered";
  if (hit >= total) return "All replied";
  if (kind === "reply") return "Partly replied";
  return hit / total >= 0.5 ? "Half or more" : "Under half";
}

/** 고객 목록의 머리 칸 정렬·필터 규칙. 표에 그리는 열(columns)과 key 로 짝지어진다. */
const customerHeadCols: HeadCol<SettingsCustomer>[] = [
  { key: "name", text: (r) => r.name || "" },
  { key: "country", text: (r) => r.country || "", filter: "facet",
    facetValues: partyRegions, emptyLabel: "No region" },
  { key: "contact", text: (r) => r.contact || "", emptyLabel: "No contact" },
  { key: "inquiries", text: (r) => relationState(r.inquiries ?? 0, r.won ?? 0, "win"),
    sortValue: (r) => r.inquiries ?? 0, filter: "facet", emptyLabel: "No inquiry yet" },
  { key: "specialization", text: (r) => r.specialization || "", filter: "facet",
    emptyLabel: "Unspecified" },
];

/** 공급사 목록의 머리 칸 규칙. 고객과 같은 얼개에 배지 열의 뜻만 다르다. */
const vendorHeadCols: HeadCol<SettingsVendor>[] = [
  { key: "name", text: (r) => r.name || "" },
  { key: "country", text: (r) => r.country || "", filter: "facet",
    facetValues: partyRegions, emptyLabel: "No region" },
  { key: "contact", text: (r) => r.contact || "", emptyLabel: "No contact" },
  { key: "deals", text: (r) => relationState(r.deals ?? 0, r.deals_answered ?? 0, "reply"),
    sortValue: (r) => r.deals ?? 0, filter: "facet", emptyLabel: "Never asked" },
  { key: "specialization", text: (r) => r.specialization || "", filter: "facet",
    emptyLabel: "Unspecified" },
];

// 품목 목록의 머리 칸 정렬·필터 규칙. 표에 그리는 열(columns)과 key 로 짝지어진다.
const itemHeadCols: HeadCol<SettingsItem>[] = [
  // 한 품목이 여러 딜에 걸치므로 판정은 전부(facetValues), 정렬은 대표(최근) 번호로.
  { key: "project_no", text: (r) => itemProjects(r)[0] || "", filter: "facet",
    facetValues: itemProjects, emptyLabel: "No deal yet" },
  { key: "customer", text: (r) => r.customer || "", filter: "facet", emptyLabel: "Unspecified" },
  // 선박도 딜처럼 한 품목에 여럿이라 판정은 전부, 표시·정렬은 최근 한 척으로.
  { key: "vessel", text: (r) => itemVessels(r)[0] || "", filter: "facet",
    facetValues: itemVessels, emptyLabel: "No vessel" },
  // 결말은 딜 하나에 하나뿐 — 세운 배지 그대로 고르면 된다(정렬은 진행 순서로).
  { key: "deal_state", text: (r) => DEAL_LABEL[r.deal_state || ""] || "", filter: "facet",
    sortValue: (r) => DEAL_RANK[r.deal_state || ""] ?? 0, emptyLabel: "No deal yet" },
  { key: "description", text: (r) => r.description || "" },
  { key: "part_no", text: (r) => r.part_no || "" },
  { key: "category_path", text: (r) => r.category_path || "", filter: "facet",
    emptyLabel: "Unclassified" },
  { key: "maker", text: (r) => r.maker || "", filter: "facet", emptyLabel: "Unspecified" },
  { key: "origin", text: (r) => r.origin || "", filter: "facet", emptyLabel: "Unspecified" },
  { key: "unit", text: (r) => r.unit || "", filter: "facet" },
  { key: "hs_code", text: (r) => r.hs_code || "", filter: "facet", emptyLabel: "Unspecified" },
  { key: "vendor", text: (r) => r.vendor || "", filter: "facet", emptyLabel: "Unspecified" },
  // 금액은 통화가 섞여 있다 — USD 환산 없이 견주면 숫자가 뒤집히므로 원 통화 값으로
  // 정렬하되 통화를 앞세운다(같은 통화끼리 모인 뒤 금액 순).
  { key: "buy", text: (r) => priceSortText(r.buy) },
  { key: "sell", text: (r) => priceSortText(r.sell) },
  // 마진 없는 행은 맨 아래로 내리되 유한한 값으로 — -Infinity 끼리 빼면 NaN 이라
  // 비교가 무너진다(값 없는 행이 대부분인 표에서 정렬이 제멋대로가 된다).
  { key: "margin_pct", text: (r) => String(r.margin_pct ?? ""),
    sortValue: (r) => r.margin_pct ?? -1e9 },
  { key: "std_price", text: (r) => String(r.std_price ?? 0), sortValue: (r) => r.std_price || 0 },
];

/** 금액 정렬 키 — "USD 000000123.45"(통화 먼저, 금액은 자릿수 맞춰 문자 정렬). */
function priceSortText(p: { unit_price: number; currency: string } | null): string {
  if (!p) return "";
  return `${p.currency} ${(p.unit_price || 0).toFixed(2).padStart(15, "0")}`;
}

export function ItemsTab({ kind = "part" }: { kind?: ItemKind }) {
  const isService = kind === "service";
  // 고객·공급사·구매가·판매가·마진은 가격 이력에서 온 읽기전용 파생값이라 편집 폼엔 없다.
  const trade: [keyof SettingsItem, string, ((r: SettingsItem) => React.ReactNode)?, string?][] = [
    ["vendor", "Vendor", (r) => r.vendor || <span className="dash">—</span>, "ms-party"],
    // 견적일은 각자 짝인 가격과 한 칸에 위아래로 — 공급사 견적(수신) → 구매가,
    // 우리 견적(제출) → 판매가. 날짜를 독립 열로 두면 물품 탭이 16열이 되어 오른쪽
    // 서너 칸(판매가·마진·편집)이 화면 밖으로 밀려났다.
    ["buy", "Purchase Price",
      (r) => priceWithDate(r.buy, r.vendor_quote_at, "Vendor quote received"), "ms-num"],
    ["sell", "Sales Price",
      (r) => priceWithDate(r.sell, r.quoted_at, "Our quote sent"), "ms-num"],
    ["margin_pct", "Margin", (r) => marginText(r.margin_pct, r.margin_cross), "ms-num"],
    // Std Price(표준가)는 아직 쓰지 않아 표에서 뺐다 — 값은 편집 폼에 그대로 있고,
    // 다시 필요해지면 아래 한 줄을 되살리면 된다.
    // ["std_price", "Std Price", undefined, "ms-num"],
  ];
  // 이 품목이 나온 딜 — 다른 화면과 같은 자리(맨 왼쪽)·같은 모양(ProjectNo)으로.
  // 재발주 품목은 딜이 여럿이라 가장 최근 것만 세우고 나머지는 "+N" 으로 알린다.
  // 필터는 보이는 번호가 아니라 걸린 딜 전부를 본다 — P-024 를 고르면 그 딜에 들어간
  // 품목이 모두 남는다(그 딜이 이 품목의 최근 딜이 아니어도).
  const project: [keyof SettingsItem, string, ((r: SettingsItem) => React.ReactNode)?, string?] =
    ["project_no", "Project No.",
      (r) => multiCell(itemProjects(r), (v) => <ProjectNo value={v} />), "ms-projcol"];
  // 딜의 결말 — 수주까지 갔는지, 대금까지 받았는지, 접었다면 왜인지. 배지 아래 회색
  // 한 줄이 그 까닭이다(완납일 / 미수 사유 / 종결 사유). 품목이 여러 딜에 걸치면
  // Project No. 가 세운 그 딜(가장 최근)의 결말이다.
  const deal: [keyof SettingsItem, string, ((r: SettingsItem) => React.ReactNode)?, string?] =
    ["deal_state", "Deal", (r) => {
      const st = r.deal_state || "";
      if (!st) return <span className="dash">—</span>;
      return (
        <span className="deal-cell">
          <span className={`deal-pill deal-${st}`}>{DEAL_LABEL[st] || st}</span>
          {r.deal_note
            ? <span className="deal-note" title={r.deal_note}>{r.deal_note}</span>
            : null}
        </span>
      );
    }, "ms-deal"];
  // 선박 — 딜을 따라온다(그 딜이 다룬 배). 여러 척이면 최근 한 척 + "+N".
  const vessel: [keyof SettingsItem, string, ((r: SettingsItem) => React.ReactNode)?, string?] =
    ["vessel", "Vessel", (r) => multiCell(itemVessels(r)), "ms-vessel"];
  const category: [keyof SettingsItem, string, ((r: SettingsItem) => React.ReactNode)?, string?] =
    ["category_path", "Category", (r) => r.category_path
      // 3단 경로는 알약 폭을 400px 가까이 끌고 간다 — 폭을 못 박고 넘치면 말줄임,
      // 전체 경로는 title 로 읽는다(가격 이력 표와 같은 방식).
      ? <span className="cat-path" title={r.category_path}>{r.category_path}</span>
      : <span className="dash">Unclassified</span>];

  return (
    <MasterSection<SettingsItem>
      title={ITEM_KIND_LABEL[kind]}
      empty={{ id: 0, part_no: "", description: "", maker: "", origin: "", unit: isService ? "EA" : "PCS", hs_code: "", std_price: 0, item_type: kind, category_id: null, category_path: "", customer: "", vendor: "", vendor_quote_at: "", quoted_at: "", buy: null, sell: null, margin_pct: null, margin_cross: false }}
      // 마스터는 한 벌이고 탭은 그중 한쪽만 본다 — 목록을 받아 이 탭의 구분만 남긴다.
      load={() => fetchSettingsItems().then((rows) => rows.filter((r) => (r.item_type || "part") === kind))}
      // 마스터의 분류가 곧 품목표 Category 셀의 값이므로, 저장·삭제 후 공유 캐시를 비운다.
      create={async (b) => {
        const r = await createSettingsItem(b);
        invalidateMasterCategories();
        return r;
      }}
      update={async (id, b) => {
        const r = await updateSettingsItem(id, b);
        invalidateMasterCategories();
        return r;
      }}
      remove={async (id) => {
        const r = await deleteSettingsItem(id);
        invalidateMasterCategories();
        return r;
      }}
      // 앞쪽은 "누구에게 판 무엇인가"(고객·설명), 뒤쪽은 거래 조건(공급사·구매가·
      // 판매가·마진) 순이고, 딜의 결말(Deal)은 그 조건을 읽은 다음에 보는 값이라
      // 마진 오른쪽 맨 끝에 둔다. 용역 탭은 품번·제조사·원산지·HS 코드를 걷어낸다(전부 빈칸이라).
      columns={isService
        ? [
            project,
            ["customer", "Customer", (r) => r.customer || <span className="dash">—</span>, "ms-party"],
            vessel,
            ["description", "Service", undefined, "ms-desc"],
            category,
            ["unit", "Unit"],
            ...trade,
            deal,
          ]
        : [
            project,
            ["customer", "Customer", (r) => r.customer || <span className="dash">—</span>, "ms-party"],
            vessel,
            ["description", "Description", undefined, "ms-desc"],
            ["part_no", "Part No."],
            category,
            ["maker", "Maker"],
            ["origin", "Origin"],
            ["unit", "Unit"],
            ["hs_code", "HS Code"],
            ...trade,
            deal,
          ]}
      // 머리 칸을 누르면 그 열로 정렬하거나 값을 골라 거를 수 있다. 값의 가짓수가
      // 적은 열(분류·상대처·제조사·원산지·단위·프로젝트)은 고르는 목록으로, 품명·품번처럼
      // 행마다 다른 열과 금액 열은 정렬만 — 목록으로 만들면 행 수만큼 긴 메뉴가 된다.
      headCols={itemHeadCols}
      tableClass="ms-table--items"
      fields={isService
        ? [
            ["description", "Service Name *"],
            ["unit", "Unit"],
            ["std_price", "Std Price"],
            ["item_type", "Type"],
          ]
        : [
            ["part_no", "Part No. *"],
            ["description", "Description"],
            ["maker", "Maker"],
            ["origin", "Origin"],
            ["unit", "Unit"],
            ["hs_code", "HS Code"],
            ["std_price", "Std Price"],
            ["item_type", "Type"],
          ]}
      // 용역은 품번이 없다 — 필수 칸이 설명(용역명)으로 바뀐다.
      required={isService ? "description" : "part_no"}
      numeric={["std_price"]}
      // 검색은 화면 컬럼 기본값 대신 직접 지정 — 가격 열은 객체라 기본 문자열화가 안 된다.
      searchText={(r) => [...itemProjects(r), ...itemVessels(r),
        DEAL_LABEL[r.deal_state || ""] || "", r.deal_note || "", r.customer, r.description, r.part_no, r.category_path, r.maker, r.origin, r.hs_code, r.vendor].join(" ")}
      // Type 을 바꿔 저장하면 그 항목은 반대편 탭으로 옮겨 간다(잘못 잡힌 구분 교정용).
      renderField={({ key, label, form, setForm }) =>
        key === "item_type" ? (
          <label className="form-field" key="item_type">
            <span>{label}</span>
            <select
              value={form.item_type || "part"}
              onChange={(e) => setForm({ ...form, item_type: e.target.value as ItemKind })}
            >
              <option value="part">Parts — 물품</option>
              <option value="service">Service — 용역</option>
            </select>
          </label>
        ) : null
      }
      extraForm={(form, setForm) => (
        <CategoryPicker
          value={form.category_id}
          onChange={(category_id) => setForm({ ...form, category_id })}
        />
      )}
    />
  );
}


// 품목 분류 캐스케이딩 선택(대>중>소). value=가장 깊은 선택 노드 id. 미분류=null.
// 저장은 항상 '가장 깊게 선택된' 노드를 value 로 둔다(대만 선택→대 id, 소까지→소 id).
function CategoryPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [cats, setCats] = useState<ItemCategory[]>([]);
  useEffect(() => {
    fetchItemCategories().then(setCats).catch(() => setCats([]));
  }, []);

  const byId = new Map(cats.map((c) => [c.id, c]));
  // Rebuild the ancestor chain [main, sub, detail] from the current value.
  const chain: number[] = [];
  let cur = value != null ? byId.get(value) : undefined;
  let guard = 0;
  while (cur && guard++ < 5) {
    chain.unshift(cur.id);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  const l1 = chain[0] ?? null;
  const l2 = chain[1] ?? null;
  const l3 = chain[2] ?? null;

  const opts = (level: number, parent: number | null) =>
    cats
      .filter((c) => c.level === level && (c.parent_id ?? null) === parent && c.active)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const l1Opts = opts(1, null);
  const l2Opts = l1 != null ? opts(2, l1) : [];
  const l3Opts = l2 != null ? opts(3, l2) : [];

  return (
    <label className="form-field cat-picker">
      <span>Category (Main · Sub · Detail)</span>
      <div className="cat-picker-row">
        <select value={l1 ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Main</option>
          {l1Opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={l2 ?? ""}
          disabled={l1 == null || l2Opts.length === 0}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : l1)}
        >
          <option value="">{l1 == null ? "—" : "Sub"}</option>
          {l2Opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={l3 ?? ""}
          disabled={l2 == null || l3Opts.length === 0}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : l2)}
        >
          <option value="">{l2 == null ? "—" : "Detail"}</option>
          {l3Opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {value == null ? <span className="hint-inline">Unclassified — pick a Main category first.</span> : null}
    </label>
  );
}

const LEVEL_LABEL: Record<number, string> = { 1: "Main", 2: "Sub", 3: "Detail" };

type CatEditor = {
  id: number | null;        // null = new
  parent_id: number | null;
  level: number;
  name: string;
  active: boolean;
  parentPath: string;       // parent path for display
};

// Item category tree (Main > Sub > Detail) management tab. Edited with "settings" master-data permission.
// 선택된 분류 필터 — 전체 / 특정 분류(하위 포함) / 미연결(마스터 없음)
type LedgerFilter = { kind: "all" } | { kind: "cat"; id: number } | { kind: "unmatched" };

// 가격 목록표의 컬럼 정의 — 폭 조절·숨김·순서 변경(useColumnLayout, localStorage) 대상.
// 좌측 선택 체크박스 열은 구조 컬럼이라 여기 넣지 않는다.
// 기본 폭(px). 품명은 두 줄로 접히지만 분류는 한 줄이라, 접히지 않는 쪽에 폭을 준다 —
// 계통 트리의 경로는 "Engine Room > Main Engine System" 처럼 길다.
const LEDGER_COLS: { key: string; label: string; width: number; numeric?: boolean }[] = [
  { key: "part_no", label: "Part No.", width: 100 },
  { key: "description", label: "Description", width: 200 },
  { key: "maker", label: "Maker", width: 110 },
  // 거래 상대는 제 가격 옆에 둔다 — 공급사→구매가, 고객사→판매가 순으로 읽힌다.
  { key: "vendor", label: "Vendor", width: 132 },
  { key: "buy", label: "Buy", width: 128, numeric: true },
  { key: "customer", label: "Customer", width: 132 },
  { key: "sell", label: "Sell", width: 128, numeric: true },
  { key: "margin", label: "Margin", width: 72, numeric: true },
  { key: "deals", label: "Deals", width: 56, numeric: true },
  { key: "last", label: "Last", width: 84 },
  // 300px = 측정값 기준. "Engine Room > Main Engine System"(241px)처럼 흔한 2단 경로와
  // "Service > Labor & Travel > Accommodation"(280px)까지 온전히 들어간다. 더 긴 3단
  // 경로는 말줄임 + title 로 읽는다.
  { key: "category", label: "Category", width: 300 },
];

/** 목록 행의 안정적 식별자 — 마스터 연결 행은 item_id, 미연결 행은 품목 식별키. */
function ledgerRowKey(it: ItemLedgerRow): string {
  return it.item_id != null ? `i${it.item_id}` : `u:${it.part_no}|${it.description}`;
}

function ledgerCellClass(key: string, numeric?: boolean): string {
  if (key === "description") return "ledger-desc";
  if (key === "category") return "ledger-cat";
  if (key === "vendor" || key === "customer") return "ledger-party";
  return numeric ? "num" : "";
}

/** Category 를 뺀 나머지 컬럼의 셀 값(Category 는 버튼이라 호출부에서 직접 렌더). */
function ledgerCellValue(key: string, it: ItemLedgerRow): React.ReactNode {
  switch (key) {
    case "part_no":
      return it.part_no || <span className="dash">—</span>;
    case "description":
      return it.description;
    case "maker":
      return it.maker || "";
    case "vendor":
      return it.vendor ? <VendorName name={it.vendor} /> : <span className="dash">—</span>;
    case "customer":
      return it.customer ? <CustomerName name={it.customer} /> : <span className="dash">—</span>;
    case "buy":
      return fmtPrice(it.buy);
    case "sell":
      return fmtPrice(it.sell);
    case "margin":
      return marginPct(it);
    case "deals":
      return `${it.buy_count}/${it.sell_count}`;
    case "last":
      return it.last_date || "";
    default:
      return null;
  }
}

const SOURCE_LABEL: Record<string, string> = {
  vendor_quote: "Vendor Quote",
  po: "Purchase Order",
  quotation: "Quotation",
  order: "Order",
  ci: "Commercial Invoice",
  ar: "Tax Invoice",
};

// 금액은 정수로 — 품목 단가는 원 단위까지가 읽을 값이고, ".00" 은 칸 폭만 먹는다.
// (표시만 반올림한다. 저장된 값과 마진 계산은 소수점 그대로다.)
function fmtAmt(n: number): string {
  return Math.round(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
// 환율은 금액이 아니다 — "1,384.50" 의 소수점 아래가 값의 일부라 그대로 둔다.
function fmtRate(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPrice(p: { unit_price: number; currency: string } | null): string {
  return p ? `${p.currency} ${fmtAmt(p.unit_price)}` : "—";
}
// 금액과 그 금액이 나온 견적일을 한 칸에(위=금액, 아래=회색 날짜). 날짜가 없으면 금액만.
function priceWithDate(
  p: { unit_price: number; currency: string } | null,
  date: string | undefined,
  dateTitle: string,
): React.ReactNode {
  return (
    <span className="ms-price">
      <span>{fmtPrice(p)}</span>
      {date ? <span className="ms-price-date" title={dateTitle}>{date}</span> : null}
    </span>
  );
}
// 마진% — 백엔드가 USD 환산으로 계산해 준 margin_pct 사용. 통화가 달라 환산된
// 값이면 '~'를 붙여 근사치임을 표시(환율 가정으로 산출).
function marginPct(row: ItemLedgerRow): string {
  return marginText(row.margin_pct, row.margin_cross);
}
function marginText(pct: number | null | undefined, cross?: boolean): string {
  if (pct == null) return "—";
  return `${cross ? "~" : ""}${pct.toFixed(1)}%`;
}
function fmtBuiltAt(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "";
}

export function CategoriesTab() {
  const [rows, setRows] = useState<ItemCategory[]>([]);
  const [editor, setEditor] = useState<CatEditor | null>(null);
  const [err, setErr] = useState("");
  const canCreate = can("settings", "create");
  const canEdit = can("settings", "edit");
  const canDelete = can("settings", "delete");

  // ── 품목 가격 이력(ledger) ────────────────────────────────────────────────
  const [ledger, setLedger] = useState<ItemLedger | null>(null);
  const [filter, setFilter] = useState<LedgerFilter>({ kind: "all" });
  const [rebuilding, setRebuilding] = useState(false);
  const [purging, setPurging] = useState(false);
  const [histRow, setHistRow] = useState<ItemLedgerRow | null>(null);
  const [hist, setHist] = useState<ItemPriceRow[] | null>(null);
  const [assignRow, setAssignRow] = useState<ItemLedgerRow | null>(null);
  const [assignCat, setAssignCat] = useState<number | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  // 다중 선택 → 한 분류로 일괄 배정. 키는 ledgerRowKey(행 순서가 바뀌어도 유지된다).
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  // Shift+클릭 구간 선택의 기준점(마지막으로 직접 누른 행의 key).
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  // 자동 분류 — 제안을 먼저 보여 주고, 고른 것만 반영한다(바로 쓰지 않는다).
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoRows, setAutoRows] = useState<AutoCategoryProposal[] | null>(null);
  const [autoPending, setAutoPending] = useState(0);
  const [autoSkip, setAutoSkip] = useState<Set<number>>(() => new Set());
  const [autoBusy, setAutoBusy] = useState(false);
  const [note, setNote] = useState("");
  // 거래 이력이 한 번도 없는 품목 수 — 지울 대상. 서버가 다시 세지만, 버튼에 개수를
  // 보이려면 화면도 알아야 한다(매입·매출 이력 건수가 둘 다 0인 행).
  const unusedCount = (ledger?.items ?? []).filter(
    (r) => (r.buy_count ?? 0) === 0 && (r.sell_count ?? 0) === 0,
  ).length;
  // 목록표 컬럼 폭·순서·표시(브라우저에 저장).
  const ledgerCols = useColumnLayout("item-ledger", LEDGER_COLS);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const shownCols = ledgerCols.visibleKeys
    .map((k) => LEDGER_COLS.find((c) => c.key === k))
    .filter((c): c is (typeof LEDGER_COLS)[number] => !!c);
  // Category 열 우측 고정(sticky)은 그 열이 맨 끝일 때만 — 순서를 바꿔 가운데로 오면
  // 오른쪽 열들을 덮어버리므로 고정을 끈다.
  const catSticky = shownCols[shownCols.length - 1]?.key === "category";
  // 펴 둔 분류(노드 id). 담는 것이 '접은 것'이 아니라 '편 것'인 데는 이유가 있다 —
  // 처음 열었을 때는 전부 접혀 있어야 하는데, 그 시점에는 분류가 아직 도착하지 않아
  // 접을 id 목록을 만들 수가 없다. 비어 있는 것이 곧 '전부 접힘'이 되게 뒤집어 둔다.
  // 나무는 일곱 뿌리에 3층이라 다 펴 두면 화면 몇 번을 내려야 아래쪽 계통에 닿는다.
  // 무엇을 펴 뒀는지는 브라우저에 남긴다(폭 조절 treeW 와 같은 자리) — 새로 고칠 때마다
  // 도로 접혀 있으면 펴는 일이 매번 처음부터가 된다.
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      // 뜻이 뒤집힌 옛 키는 남겨 두면 헷갈리기만 하므로 치운다.
      window.localStorage.removeItem("ktms.catCollapsed");
      const raw = window.localStorage.getItem("ktms.catExpanded");
      return new Set<number>(raw ? (JSON.parse(raw) as number[]) : []);
    } catch {
      return new Set();
    }
  });
  function toggleNode(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      try {
        window.localStorage.setItem("ktms.catExpanded", JSON.stringify([...next]));
      } catch {
        /* 저장을 못 해도 이번 화면에서 접고 펴는 것은 그대로 된다. */
      }
      return next;
    });
  }

  // 트리↔목록 좌우 분할 폭(px). 구분선을 드래그해 조절. localStorage 로 유지.
  const [treeW, setTreeW] = useState<number>(() => {
    if (typeof window === "undefined") return 300;
    const v = Number(window.localStorage.getItem("ktms.catTreeW"));
    return v >= 180 && v <= 620 ? v : 300;
  });

  function startSplitDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeW;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(180, Math.min(620, startW + (ev.clientX - startX)));
      setTreeW(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem("ktms.catTreeW", String(treeWRef.current));
      } catch {
        /* ignore */
      }
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  // onUp(비동기 클로저)에서 최신 폭을 저장하기 위한 ref 미러.
  const treeWRef = useRef(treeW);
  treeWRef.current = treeW;

  function refresh() {
    fetchItemCategories().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  function loadLedger() {
    fetchItemLedger().then(setLedger).catch(() => setLedger(null));
  }
  useEffect(refresh, []);
  useEffect(loadLedger, []);

  const byId = new Map(rows.map((c) => [c.id, c]));
  const childrenOf = (pid: number | null) =>
    rows
      .filter((c) => (c.parent_id ?? null) === pid)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  // 분류별 배정 품목 수 — 트리 라벨 옆에 표시. 클릭하면 보이는 목록과 같은 기준이라
  // 하위 분류(중·소)에 배정된 품목까지 상위 노드 수에 합산한다.
  const catCount: Map<number, number> = (() => {
    const direct = new Map<number, number>();
    for (const it of ledger?.items ?? []) {
      if (it.category_id != null) direct.set(it.category_id, (direct.get(it.category_id) ?? 0) + 1);
    }
    const total = new Map<number, number>();
    const walk = (id: number, depth: number): number => {
      if (depth > 5) return 0;   // 데이터 이상(순환)에도 멈추도록
      let n = direct.get(id) ?? 0;
      for (const k of rows.filter((r) => r.parent_id === id)) n += walk(k.id, depth + 1);
      total.set(id, n);
      return n;
    };
    for (const r of rows.filter((c) => (c.parent_id ?? null) === null)) walk(r.id, 1);
    return total;
  })();

  // 한 분류 노드의 자기 자신 + 모든 하위 분류 id 집합(필터링용).
  function descendantIds(id: number): Set<number> {
    const out = new Set<number>([id]);
    const walk = (pid: number) => {
      for (const c of rows.filter((r) => r.parent_id === pid)) {
        out.add(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  const filtered: ItemLedgerRow[] = (() => {
    if (!ledger) return [];
    if (filter.kind === "unmatched") return ledger.unmatched;
    if (filter.kind === "all") return ledger.items;
    const ids = descendantIds(filter.id);
    return ledger.items.filter((it) => it.category_id != null && ids.has(it.category_id));
  })();

  async function rebuild() {
    setRebuilding(true);
    setErr("");
    try {
      await rebuildItemLedger();
      invalidateMasterCategories();
      loadLedger();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rebuild failed");
    } finally {
      setRebuilding(false);
    }
  }

  /**
   * 거래 이력이 한 번도 없는 품목을 지운다. 되돌릴 수 없어 개수를 보이고 한 번 묻는다.
   *
   * 금액도 거래선도 없는 행은 대개 품명이 고쳐지면서 뒤에 남겨진 옛 마스터다 — 아무도
   * 다시 찾지 않으면서 목록과 계통별 개수에만 얹혀, 배 위에 있지도 않은 품목이 실려
   * 있는 것처럼 보이게 한다.
   */
  async function purgeUnused() {
    if (!unusedCount) return;
    const ok = window.confirm(
      `Remove ${unusedCount} item(s) that have never carried a price?

`
      + "These have no buy, no sell and no counterparty on any document. "
      + "This cannot be undone.",
    );
    if (!ok) return;
    setPurging(true);
    setErr("");
    setNote("");
    try {
      const r = await purgeUnusedItems();
      setNote(`Removed ${r.removed} item(s) with no transactions.`);
      invalidateMasterCategories();
      loadLedger();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setPurging(false);
    }
  }

  async function openHistory(row: ItemLedgerRow) {
    setHistRow(row);
    setHist(null);
    try {
      const data = await fetchItemPriceHistory(
        row.item_id != null
          ? { item_id: row.item_id }
          : { part_no: row.part_no, description: row.description }
      );
      setHist(data);
    } catch {
      setHist([]);
    }
  }

  function openAssign(row: ItemLedgerRow) {
    setAssignRow(row);
    setAssignCat(row.category_id ?? null);
    setErr("");
  }
  function closeAssign() {
    setAssignRow(null);
    setAssignBusy(false);
  }

  // ── 다중 선택 ─────────────────────────────────────────────────────────────
  function toggleRow(it: ItemLedgerRow) {
    const k = ledgerRowKey(it);
    setAnchorKey(k);   // 다음 Shift+클릭의 구간 기준점
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  /** 분류 가능한(Part No. 또는 설명이 있는) 행만 선택 대상. */
  const selectable = filtered.filter((it) => it.part_no || it.description);
  const pickedRows = selectable.filter((it) => picked.has(ledgerRowKey(it)));
  const allPicked = selectable.length > 0 && pickedRows.length === selectable.length;
  function toggleAll(on: boolean) {
    setPicked(on ? new Set(selectable.map(ledgerRowKey)) : new Set());
    setAnchorKey(null);
  }

  /**
   * Shift+클릭 — 기준점(마지막으로 누른 행)부터 이번 행까지 한꺼번에.
   * 구간에는 기준점의 현재 상태를 그대로 입힌다 → 체크 후 Shift+클릭이면 구간 전체 선택,
   * 해제 후 Shift+클릭이면 구간 전체 해제(엑셀과 같은 감각).
   * 기준점이 지금 목록에 없으면(필터 변경 등) 평범한 토글로 처리한다.
   */
  function extendRange(it: ItemLedgerRow) {
    const keys = selectable.map(ledgerRowKey);
    const to = keys.indexOf(ledgerRowKey(it));
    const from = anchorKey ? keys.indexOf(anchorKey) : -1;
    if (to < 0 || from < 0) {
      toggleRow(it);
      return;
    }
    const on = picked.has(keys[from]);
    const [a, b] = from <= to ? [from, to] : [to, from];
    // Shift+클릭이 남긴 텍스트 선택(파란 하이라이트)을 정리.
    window.getSelection()?.removeAllRanges();
    setPicked((prev) => {
      const next = new Set(prev);
      for (let i = a; i <= b; i++) {
        if (on) next.add(keys[i]);
        else next.delete(keys[i]);
      }
      return next;
    });
    setAnchorKey(keys[to]);
  }

  async function openAuto() {
    setAutoOpen(true);
    setAutoRows(null);
    setAutoSkip(new Set());
    setErr("");
    setNote("");
    try {
      const r = await previewAutoClassify();
      setAutoRows(r.proposals);
      setAutoPending(r.pending);
    } catch (e) {
      setAutoRows([]);
      setErr(e instanceof Error ? e.message : "Auto-assign preview failed");
    }
  }
  async function applyAuto() {
    const picks = (autoRows ?? []).filter((_, i) => !autoSkip.has(i));
    if (picks.length === 0) return;
    setAutoBusy(true);
    setErr("");
    try {
      const r = await applyAutoClassify({
        targets: picks.map((p) => ({
          item_id: p.item_id ?? undefined,
          part_no: p.part_no,
          description: p.description,
          maker: p.maker,
          category_id: p.category_id,
        })),
      });
      setAutoOpen(false);
      invalidateMasterCategories();
      refresh();
      loadLedger();
      setNote(`${r.assigned} item(s) classified${r.skipped ? `, ${r.skipped} skipped` : ""}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Auto-assign failed");
    } finally {
      setAutoBusy(false);
    }
  }

  function openBulk() {
    setAssignCat(null);
    setBulkOpen(true);
    setErr("");
  }
  async function saveBulk() {
    if (pickedRows.length === 0) return;
    setAssignBusy(true);
    setErr("");
    try {
      const r = await assignItemLedgerCategoryBulk({
        category_id: assignCat,
        targets: pickedRows.map((it) =>
          it.item_id != null
            ? { item_id: it.item_id }
            : { part_no: it.part_no, description: it.description, maker: it.maker }
        ),
      });
      setBulkOpen(false);
      setPicked(new Set());
      invalidateMasterCategories();
      if (r.skipped > 0) setErr(`${r.skipped} item(s) skipped — no Part No. or description.`);
      loadLedger();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setAssignBusy(false);
    }
  }
  async function saveAssign() {
    if (!assignRow) return;
    setAssignBusy(true);
    setErr("");
    try {
      await assignItemLedgerCategory(
        assignRow.item_id != null
          ? { item_id: assignRow.item_id, category_id: assignCat }
          : {
              part_no: assignRow.part_no,
              description: assignRow.description,
              maker: assignRow.maker,
              category_id: assignCat,
            }
      );
      closeAssign();
      // 프로젝트 품목표가 다음 조회에서 새 분류를 읽도록 공유 캐시를 비운다(양방향 동기화).
      invalidateMasterCategories();
      loadLedger();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Assign failed");
      setAssignBusy(false);
    }
  }

  function openNew(parent: ItemCategory | null) {
    setErr("");
    setEditor({
      id: null,
      parent_id: parent ? parent.id : null,
      level: parent ? (parent.level || 1) + 1 : 1,
      name: "",
      active: true,
      parentPath: parent ? parent.path : "",
    });
  }
  function openEdit(node: ItemCategory) {
    setErr("");
    const parent = node.parent_id != null ? byId.get(node.parent_id) : undefined;
    setEditor({
      id: node.id,
      parent_id: node.parent_id,
      level: node.level,
      name: node.name,
      active: node.active,
      parentPath: parent ? parent.path : "",
    });
  }
  function cancel() {
    setEditor(null);
    setErr("");
  }

  async function save() {
    if (!editor) return;
    setErr("");
    try {
      if (editor.id == null) {
        const siblings = childrenOf(editor.parent_id).length;
        await createItemCategory({
          name: editor.name.trim(),
          parent_id: editor.parent_id,
          sort_order: siblings,
          active: editor.active,
        });
      } else {
        await updateItemCategory(editor.id, { name: editor.name.trim(), active: editor.active });
      }
      cancel();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function del(node: ItemCategory) {
    if (!confirm(`Delete category "${node.name}"?`)) return;
    setErr("");
    try {
      await deleteItemCategory(node.id);
      refresh();
    } catch (e) {
      // Backend blocks deletion when child categories or items in use exist.
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // Move a node up/down within its sibling group. Reassigns sort_order by new
  // position (self-healing) and persists only the rows whose order changed.
  async function move(node: ItemCategory, dir: -1 | 1) {
    const sibs = childrenOf(node.parent_id);
    const idx = sibs.findIndex((c) => c.id === node.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= sibs.length) return;
    const arr = [...sibs];
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    setErr("");
    try {
      await Promise.all(
        arr
          .map((c, i) =>
            c.sort_order === i
              ? null
              : updateItemCategory(c.id, { name: c.name, sort_order: i, active: c.active })
          )
          .filter((p): p is Promise<{ ok: boolean; id: number }> => p !== null)
      );
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reorder failed");
    }
  }

  function NodeRow({ node }: { node: ItemCategory }) {
    const kids = childrenOf(node.id);
    const sibs = childrenOf(node.parent_id);
    const pos = sibs.findIndex((c) => c.id === node.id);
    const isFirst = pos <= 0;
    const isLast = pos >= sibs.length - 1;
    const canHaveKids = node.level < 3;
    const isOpen = expanded.has(node.id);
    return (
      <li className={`cat-node cat-l${node.level}${node.active ? "" : " off"}`}>
        <div
          className={`cat-node-row${
            filter.kind === "cat" && filter.id === node.id ? " sel" : ""
          }`}
        >
          {/* 여닫기 — 이름을 누르면 오른쪽 목록이 그 분류로 걸리므로, 접고 펴는 것은
              따로 눌러야 한다(같은 자리에 두 뜻을 겹치면 둘 다 조심스러워진다).
              하위를 가질 수 없는 3층은 자리만 비워 이름 시작점을 맞춘다. */}
          {canHaveKids ? (
            <button
              type="button"
              className="cat-caret"
              onClick={() => toggleNode(node.id)}
              aria-expanded={isOpen}
              title={isOpen ? "Collapse" : "Expand"}
            >
              {isOpen ? "▼" : "▶"}
            </button>
          ) : (
            <span className="cat-caret cat-caret--none" aria-hidden />
          )}
          <span
            className="cat-node-name cat-node-pick"
            onClick={() => setFilter({ kind: "cat", id: node.id })}
            title="Show this category's item prices"
          >
            {node.name}
            {/* 배정된 품목 수(하위 분류 포함) — 0이면 옅게. 목록을 열지 않고도 어디에
                품목이 몰려 있는지 보인다. */}
            <span className={`cat-node-count${(catCount.get(node.id) ?? 0) === 0 ? " zero" : ""}`}>
              ({catCount.get(node.id) ?? 0})
            </span>
            {!node.active ? <span className="cat-inactive">Inactive</span> : null}
          </span>
          <span className="cat-node-actions">
            {canEdit ? (
              <>
                <button className="btn tiny" disabled={isFirst} onClick={() => move(node, -1)} title="Move up">▲</button>
                <button className="btn tiny" disabled={isLast} onClick={() => move(node, 1)} title="Move down">▼</button>
              </>
            ) : null}
            {canEdit ? (
              <button className="btn tiny" onClick={() => openEdit(node)} title="Edit">✎</button>
            ) : null}
            {canDelete ? (
              <button className="btn tiny danger" onClick={() => del(node)} title="Delete">×</button>
            ) : null}
          </span>
        </div>
        {canHaveKids && isOpen ? (
          // 하위 그룹(세로선). 자식들 + 맨 끝에 '+ 하위레벨 추가' 버튼 1개.
          <ul className="cat-children">
            {kids.map((k) => <NodeRow key={k.id} node={k} />)}
            {canCreate ? (
              <li className="cat-addrow">
                <button className="cat-add" onClick={() => openNew(node)}>
                  + {LEVEL_LABEL[node.level + 1]}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  }

  const roots = childrenOf(null);
  const editorTitle = editor
    ? editor.id == null
      ? `+ Add ${LEVEL_LABEL[editor.level] ?? "category"}`
      : `✎ Edit ${LEVEL_LABEL[editor.level] ?? "category"} — ${editor.name || ""}`
    : "";

  const filterTitle =
    filter.kind === "all"
      ? "All items"
      : filter.kind === "unmatched"
        ? "Unmatched items (no master link)"
        : byId.get(filter.id)?.path || byId.get(filter.id)?.name || "Category";

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">Item Categories · Prices</h3>
      </div>
      <p className="hint-inline" style={{ display: "block", marginBottom: 12 }}>
        Left: manage the classification (Main &gt; Sub &gt; Detail, ▲▼ to reorder). Click a category to list its
        items with the latest purchase (buy) and sales (sell) prices on the right; click a row for the full history.
      </p>

      {err ? <div className="action-err" style={{ marginBottom: 10 }}>{err}</div> : null}
      {note ? <div className="action-ok" style={{ marginBottom: 10 }}>{note}</div> : null}

      <div className="cat-layout" style={{ "--tree-w": `${treeW}px` } as React.CSSProperties}>
        <div className="cat-tree-pane">
          <div className="cat-quickfilter">
            <button
              className={`btn tiny${filter.kind === "all" ? " primary" : ""}`}
              onClick={() => setFilter({ kind: "all" })}
            >
              All items{ledger ? ` (${ledger.items.length})` : ""}
            </button>
            <button
              className={`btn tiny${filter.kind === "unmatched" ? " primary" : ""}`}
              onClick={() => setFilter({ kind: "unmatched" })}
            >
              Unmatched{ledger ? ` (${ledger.unmatched.length})` : ""}
            </button>
          </div>
          {roots.length === 0 && !canCreate ? (
            <div className="state">No categories yet.</div>
          ) : (
            <ul className="cat-tree">
              {roots.map((r) => <NodeRow key={r.id} node={r} />)}
              {canCreate ? (
                <li className="cat-addrow cat-addrow-root">
                  <button className="cat-add" onClick={() => openNew(null)}>+ Main</button>
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <div
          className="cat-splitter"
          onMouseDown={startSplitDrag}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />

        <div className="cat-ledger-pane">
          <div className="ledger-head">
            <div className="ledger-title">
              {filterTitle}
              <span className="ledger-count">{filtered.length}</span>
            </div>
            <div className="ledger-actions">
              {canEdit && pickedRows.length > 0 ? (
                <button className="btn tiny primary" onClick={openBulk}>
                  Assign category ({pickedRows.length})
                </button>
              ) : null}
              {canEdit ? (
                <button className="btn tiny" onClick={openAuto} title="Suggest categories for items that have none">
                  ✦ Auto-assign
                </button>
              ) : null}
              {ledger?.built_at ? (
                <span className="hint-inline">Built {fmtBuiltAt(ledger.built_at)}</span>
              ) : null}
              <ColumnsButton cols={LEDGER_COLS} layout={ledgerCols} />
              {canDelete && unusedCount > 0 ? (
                <button
                  className="btn tiny"
                  disabled={purging}
                  onClick={purgeUnused}
                  title="Remove items that have never carried a price on any document"
                >
                  {purging ? "Removing…" : `🗑 Unused (${unusedCount})`}
                </button>
              ) : null}
              {canEdit ? (
                <button className="btn tiny" disabled={rebuilding} onClick={rebuild}>
                  {rebuilding ? "Rebuilding…" : "↻ Rebuild"}
                </button>
              ) : null}
            </div>
          </div>

          {!ledger ? (
            <div className="state">Loading prices…</div>
          ) : filtered.length === 0 ? (
            <div className="state">
              No item prices in this view.
              {filter.kind === "cat" ? " Assign items to this category in Item Master, or try Rebuild." : " Try Rebuild."}
            </div>
          ) : (
            <div className="table-wrap">
              <table className={`mini wide ledger-table customizable${catSticky ? " cat-sticky" : ""}`}>
                <colgroup>
                  <col style={{ width: 34 }} />{/* 선택 체크박스 */}
                  {shownCols.map((c) => {
                    const w = ledgerCols.widths[c.key] ?? c.width;
                    return <col key={c.key} style={{ width: w, minWidth: w }} />;
                  })}
                </colgroup>
                <thead>
                  <tr>
                    <th className="row-tools">
                      <input
                        type="checkbox"
                        className="row-check"
                        aria-label="Select all items"
                        title="Select all · Shift+click a row range to pick a block"
                        checked={allPicked}
                        disabled={selectable.length === 0}
                        ref={(el) => {
                          if (el) el.indeterminate = pickedRows.length > 0 && !allPicked;
                        }}
                        onChange={(e) => toggleAll(e.target.checked)}
                      />
                    </th>
                    {shownCols.map((c) => (
                      <th
                        key={c.key}
                        className={`pl-th led-th-${c.key}${c.numeric ? " num" : ""}${dragCol === c.key ? " dragging" : ""}`}
                      >
                        <span
                          className="ig-th-label"
                          {...dragHandleProps(c.key, ledgerCols, { active: dragCol, set: setDragCol })}
                        >
                          {c.label}
                        </span>
                        <ColumnResizer
                          onResize={(px) => ledgerCols.setWidth(c.key, px)}
                          onResizeEnd={ledgerCols.commitWidths}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it, i) => {
                    const key = ledgerRowKey(it);
                    const classifiable = !!(it.part_no || it.description);
                    return (
                      <tr
                        key={it.item_id ?? `u${i}`}
                        className={`ledger-row${picked.has(key) ? " row-picked" : ""}`}
                        // 평소엔 이력 열기. Shift+클릭은 행 어디를 눌러도 구간 선택으로 —
                        // 체크박스만 정확히 노리지 않아도 되게(그때 이력이 열리면 방해된다).
                        onClick={(e) => {
                          if (e.shiftKey && classifiable) {
                            extendRange(it);
                            return;
                          }
                          openHistory(it);
                        }}
                        title="Show full price history · Shift+click to select a range"
                      >
                        <td className="row-tools" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="row-check"
                            aria-label="Select item"
                            title="Shift+click to select a range"
                            checked={picked.has(key)}
                            disabled={!classifiable}
                            // Shift+클릭은 기본 토글을 막고(→ onChange 안 남) 구간 선택으로 처리.
                            onClick={(e) => {
                              if (!e.shiftKey) return;
                              e.preventDefault();
                              extendRange(it);
                            }}
                            onChange={() => toggleRow(it)}
                          />
                        </td>
                        {shownCols.map((c) => (
                          <td
                            key={c.key}
                            className={ledgerCellClass(c.key, c.numeric)}
                            title={
                              c.key === "margin" && it.margin_cross
                                ? "Converted to USD using each deal's stored FX rate (app rate if none)"
                                : undefined
                            }
                            onClick={c.key === "category" ? (e) => e.stopPropagation() : undefined}
                          >
                            {c.key === "category" ? (
                              canEdit ? (
                                <button
                                  className="btn tiny"
                                  disabled={!classifiable}
                                  title={
                                    !classifiable
                                      ? "No Part No. or description — cannot classify"
                                      : it.category_path
                                        // 잘려도 전체 경로를 읽을 수 있게 — 계통 경로는 길다.
                                        ? `${it.category_path} — click to change`
                                        : "Assign category"
                                  }
                                  onClick={() => openAssign(it)}
                                >
                                  {it.category_path ? `✎ ${it.category_path}` : "＋ Assign"}
                                </button>
                              ) : (
                                it.category_path || <span className="dash">—</span>
                              )
                            ) : (
                              ledgerCellValue(c.key, it)
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {histRow ? (
        <Modal
          title={`Price history — ${histRow.part_no || histRow.description || "item"}`}
          onClose={() => { setHistRow(null); setHist(null); }}
          wide
        >
          {hist === null ? (
            <div className="state">Loading…</div>
          ) : hist.length === 0 ? (
            <div className="state">No price rows.</div>
          ) : (
            <div className="table-wrap">
              <table className="mini wide">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Source</th>
                    <th>Customer / Vendor</th>
                    <th>Vessel</th>
                    <th className="num">Unit</th>
                    <th className="num">Qty</th>
                    <th className="num">Amount</th>
                    <th className="num">FX (1 USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {hist.map((r) => (
                    <tr key={r.id}>
                      <td>{r.doc_date || "—"}</td>
                      <td>
                        <span className={`ledger-pill ${r.price_type}`}>
                          {r.price_type === "buy" ? "Buy" : "Sell"}
                        </span>
                      </td>
                      <td>{SOURCE_LABEL[r.source_type] || r.source_type}</td>
                      <td>{r.price_type === "buy" ? (r.vendor || "—") : (r.customer || "—")}</td>
                      <td>{r.vessel || ""}</td>
                      <td className="num">{r.currency} {fmtAmt(r.unit_price)}</td>
                      <td className="num">{r.qty}</td>
                      <td className="num">{r.currency} {fmtAmt(r.amount)}</td>
                      <td className="num">{r.fx_rate ? `₩${fmtRate(r.fx_rate)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      ) : null}

      {autoOpen ? (
        <Modal
          title="Auto-assign categories"
          onClose={() => setAutoOpen(false)}
          form
        >
          <p className="hint-inline" style={{ display: "block", marginBottom: 10 }}>
            Categories are guessed from what is already classified — an identical description,
            a shared part-number family, a description that is nearly the same as a classified
            one, or a category name the description contains (shipyard shorthand is read too:
            V/V is a valve, L.O. is lubricating oil). Each line says which. Untick anything that
            looks wrong; items with no clear match are left alone rather than filed somewhere
            plausible.
          </p>
          {autoRows === null ? (
            <div className="state">Reading items…</div>
          ) : autoRows.length === 0 ? (
            <div className="state">
              Nothing to suggest{autoPending ? ` — ${autoPending} item(s) still unclassified, none with a clear match` : ""}.
            </div>
          ) : (
            <>
              <div className="table-wrap auto-cat-wrap">
                <table className="mini wide">
                  <thead>
                    <tr>
                      <th className="row-tools">
                        <input
                          type="checkbox"
                          className="row-check"
                          aria-label="Select all suggestions"
                          checked={autoSkip.size === 0}
                          onChange={(e) =>
                            setAutoSkip(e.target.checked ? new Set() : new Set(autoRows.map((_, i) => i)))
                          }
                        />
                      </th>
                      <th>Part No.</th>
                      <th>Description</th>
                      <th>Category</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {autoRows.map((p, i) => (
                      <tr key={`${p.item_id ?? "u"}-${p.part_no}-${p.description}`}
                          className={autoSkip.has(i) ? "auto-cat-off" : ""}>
                        <td className="row-tools">
                          <input
                            type="checkbox"
                            className="row-check"
                            aria-label={`Apply ${p.part_no || p.description}`}
                            checked={!autoSkip.has(i)}
                            onChange={() =>
                              setAutoSkip((prev) => {
                                const next = new Set(prev);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td>{p.part_no || <span className="dash">—</span>}</td>
                        <td className="auto-cat-desc">
                          <span title={p.description}>{p.description}</span>
                        </td>
                        <td className="auto-cat-path">
                          {p.category_path}
                          {p.item_id == null ? <span className="auto-cat-new">new item</span> : null}
                        </td>
                        <td className="auto-cat-why">{p.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
                {autoPending - autoRows.length > 0
                  ? `${autoPending - autoRows.length} item(s) had no clear match and stay unclassified.`
                  : "Every unclassified item got a suggestion."}
              </p>
            </>
          )}
          <div className="form-actions">
            <button
              className="btn primary"
              disabled={autoBusy || !autoRows || autoRows.length - autoSkip.size === 0}
              onClick={applyAuto}
            >
              {autoBusy ? "Applying…" : `Apply ${autoRows ? autoRows.length - autoSkip.size : 0}`}
            </button>
            <button className="btn" disabled={autoBusy} onClick={() => setAutoOpen(false)}>Cancel</button>
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </Modal>
      ) : null}

      {bulkOpen ? (
        <Modal
          title={`Assign category — ${pickedRows.length} item(s)`}
          onClose={() => setBulkOpen(false)}
          form
        >
          <p className="hint-inline" style={{ display: "block", marginBottom: 10 }}>
            Every selected item gets this classification. Items not yet in Item Master are
            registered and their price history is linked.
          </p>
          <ul className="bulk-target-list">
            {pickedRows.slice(0, 8).map((it) => (
              <li key={ledgerRowKey(it)}>
                {it.part_no ? <b>{it.part_no}</b> : null} {it.description}
              </li>
            ))}
            {pickedRows.length > 8 ? <li className="muted">… {pickedRows.length - 8} more</li> : null}
          </ul>
          <CategoryPicker value={assignCat} onChange={setAssignCat} />
          <div className="form-actions">
            <button className="btn primary" disabled={assignBusy} onClick={saveBulk}>
              {assignBusy ? "Saving…" : `Assign ${pickedRows.length}`}
            </button>
            <button className="btn" disabled={assignBusy} onClick={() => setBulkOpen(false)}>Cancel</button>
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </Modal>
      ) : null}

      {assignRow ? (
        <Modal
          title={`Assign category — ${assignRow.part_no || assignRow.description || "item"}`}
          onClose={closeAssign}
          form
        >
          <p className="hint-inline" style={{ display: "block", marginBottom: 10 }}>
            {assignRow.item_id != null
              ? "Change this item's classification."
              : "This item is not yet in Item Master. Assigning a category registers it and links its price history."}
          </p>
          <CategoryPicker value={assignCat} onChange={setAssignCat} />
          <div className="form-actions">
            <button className="btn primary" disabled={assignBusy} onClick={saveAssign}>
              {assignBusy ? "Saving…" : "Save"}
            </button>
            <button className="btn" disabled={assignBusy} onClick={closeAssign}>Cancel</button>
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </Modal>
      ) : null}

      {editor ? (
        <Modal title={editorTitle} onClose={cancel} form>
          <div className="form-grid">
            {editor.parentPath ? (
              <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                <span>Parent category</span>
                <div className="cat-parent-path">{editor.parentPath}</div>
              </div>
            ) : null}
            <TextField
              label={`${LEVEL_LABEL[editor.level] ?? "Category"} name *`}
              value={editor.name}
              onChange={(v) => setEditor({ ...editor, name: v })}
            />
            <label className="check-inline">
              <input
                type="checkbox"
                checked={editor.active}
                onChange={(e) => setEditor({ ...editor, active: e.target.checked })}
              />
              Active (inactive is hidden from pickers)
            </label>
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={save} disabled={!editor.name.trim()}>
              {editor.id == null ? "Add" : "Save"}
            </button>
            <button className="btn" onClick={cancel}>Cancel</button>
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </Modal>
      ) : null}
    </div>
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
  topForm,
  renderField,
  allowCopy = false,
  copyHint,
  onSaved,
  group,
  searchText,
  twoCol = false,
  tableClass = "",
  reloadKey = 0,
  headCols,
}: {
  title: string;
  empty: T;
  load: () => Promise<T[]>;
  create: (body: Omit<T, "id">) => Promise<unknown>;
  update: (id: number, body: Omit<T, "id">) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
  // 각 컬럼: [키, 헤더라벨, (선택)셀 커스텀 렌더, (선택)칸 클래스 — th·td 공통]
  columns: [keyof T, string, ((row: T) => ReactNode)?, string?][];
  fields: [keyof T, string][];
  required: keyof T;
  numeric?: (keyof T)[];
  extraForm?: (form: T, setForm: (next: T) => void) => ReactNode;
  // 폼 상단(입력 칸 위) 영역 — 명함 스캔 같은 자동 입력 도구를 넣는다.
  topForm?: (form: T, setForm: (next: T) => void, rows: T[]) => ReactNode;
  // fields 중 일부를 커스텀 입력으로 대체(예: 기존 값 목록에서 고르는 콤보박스).
  // null 을 반환하면 기본 TextField 를 쓴다. rows = 현재 등록된 전체 목록.
  renderField?: (ctx: {
    key: keyof T;
    label: string;
    form: T;
    setForm: (next: T) => void;
    rows: T[];
  }) => ReactNode | null;
  allowCopy?: boolean; // 기존 항목 정보를 복사해 새 레코드로 등록 허용
  copyHint?: string; // 복사 모드 안내 문구
  onSaved?: () => void; // 생성/수정/삭제 성공 후 호출(예: 로고 캐시 무효화)
  // 회사 단위 묶어보기(레코드 1건 = 담당자 1명이라 같은 회사가 여러 행으로 반복된다).
  // 담당자가 2명 이상인 회사만 접었다 펴고, 1명뿐인 회사는 지금처럼 단일 행으로 둔다.
  group?: {
    by: (row: T) => string;
    // 그룹 헤더 행의 각 칸(columns 와 같은 개수). expanded = 펼침 여부(화살표 표시용).
    cells: (rows: T[], expanded: boolean) => ReactNode[];
    // 하위 행의 첫 칸 — 기본은 빈칸(회사명·로고 반복을 없앤다).
    subFirst?: (row: T) => ReactNode;
    // 헤더 우측 버튼. addNew() = 그룹 공통정보가 채워진 신규 등록 폼 열기.
    /** 헤더 우측 버튼. addNew() = 그룹 공통정보가 채워진 신규 등록 폼 열기.
     *  nav = 같은 표의 회사 목록과 이 회사의 자리 — 회사 정보 창이 옆 회사로 건너뛰는 데 쓴다. */
    actions?: (
      rows: T[],
      addNew: () => void,
      nav: { groups: T[][]; index: number; editRow: (row: T) => void },
    ) => ReactNode;
    newRow?: (rows: T[]) => T;
    summary?: (groups: number, items: number) => string;
  };
  // 검색 대상 텍스트(기본: 표시 컬럼 값). 화면에 접혀 있는 값(2번째 이메일·전화·주소)까지 넓힐 때.
  searchText?: (row: T) => string;
  // 그룹 목록을 좁은 표 2개로 나눠 나란히 놓는다(넓은 화면의 빈 공간 줄이기).
  twoCol?: boolean;
  // 표에 덧붙일 클래스 — 칸 폭 배분을 이 표의 내용에 맞게 갈아끼울 때(globals.css 참고).
  // ms-table--even = 남는 폭을 첫 칸에 몰아주지 않고 칸마다 내용에 비례해 나눠 준다.
  tableClass?: string;
  // 값이 바뀌면 목록을 다시 불러온다(바깥에서 저장했을 때 — 예: 회사 공통정보 일괄 수정).
  reloadKey?: number;
  // 머리 칸에서 거는 정렬·필터. columns 의 키와 같은 key 를 준 열만 메뉴가 달리고,
  // 나머지는 평범한 머리 칸으로 남는다. 안 주면 표는 지금까지와 똑같이 그려진다.
  headCols?: HeadCol<T>[];
}) {
  const NEW_ID = -1; // editId 센티넬: 신규 등록 편집기
  const [rows, setRows] = useState<T[]>([]);
  const [editId, setEditId] = useState<number | null>(null); // null=닫힘, -1=신규, >0=수정
  const [form, setForm] = useState<T>(empty);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [copying, setCopying] = useState(false); // 복사 모드(기존 정보 복제 → 새 레코드)
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set()); // 펼쳐 둔 그룹(회사)
  // 마스터 데이터 입력·수정·삭제 권한(= "settings" 모듈). admin 은 항상 true.
  const canCreate = can("settings", "create");
  const canEdit = can("settings", "edit");
  const canDelete = can("settings", "delete");
  // 표 갈래(title)가 바뀌면 걸어 둔 필터를 지운다 — 앞 갈래에서 고른 값이 새 목록에
  // 없으면 표가 통째로 빈 것처럼 보인다.
  const head = useHeadMenu<T>(headCols ?? [], title);
  const headByKey = new Map((headCols ?? []).map((c) => [c.key, c]));

  function refresh() {
    load().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }

  useEffect(refresh, [reloadKey]);

  function openNew() {
    setForm(empty);
    setErr("");
    setCopying(false);
    setEditId(NEW_ID);
  }
  // 그룹(회사) 헤더의 "+ 담당자" — 회사 공통정보가 채워진 상태로 신규 등록 폼을 연다.
  // 저장 후 목록이 새로 그려져도 그 회사는 펼친 채로 둔다(추가된 담당자가 바로 보이게).
  function openNewIn(rows: T[]) {
    if (group) setOpenKeys((prev) => new Set(prev).add(group.by(rows[0])));
    setForm(group?.newRow?.(rows) ?? empty);
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
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function delRow() {
    if (!editId || editId < 0 || !confirm("Delete the selected item?")) return;
    setErr("");
    try {
      await remove(editId);
      cancel();
      refresh();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const requiredValue = String(form[required] ?? "").trim();
  const ql = q.trim().toLowerCase();
  const searched = ql
    ? rows.filter((r) =>
        searchText
          ? searchText(r).toLowerCase().includes(ql)
          : columns.some(([key]) => String(r[key] ?? "").toLowerCase().includes(ql))
      )
    : rows;
  // 머리 칸 정렬·필터는 검색으로 좁힌 목록을 다시 자른다(검색 → 열 필터 → 정렬 순).
  const filtered = head.apply(searched);
  const isEdit = !!editId && editId > 0;

  // 같은 키(회사)끼리 묶기 — 원래 정렬 순서를 유지한다.
  const groups: { key: string; rows: T[] }[] = [];
  if (group) {
    for (const r of filtered) {
      const k = group.by(r);
      const hit = groups.find((g) => g.key === k);
      if (hit) hit.rows.push(r);
      else groups.push({ key: k, rows: [r] });
    }
  }
  // 회사 목록을 순서 그대로 — 2열로 잘라 그려도 '다음 회사'는 자른 조각이 아니라
  // 전체 순서를 따라야 한다(회사 정보 창의 좌우 이동).
  const groupRows = groups.map((g) => g.rows);
  const groupIndex = new Map(groups.map((g, i) => [g.key, i]));
  // 검색 중에는 매칭된 담당자가 보여야 하므로 전부 펼친다.
  const expandAll = !!ql;
  const isOpen = (key: string) => expandAll || openKeys.has(key);
  const allOpen = groups.length > 0 && groups.every((g) => openKeys.has(g.key));
  function toggleGroup(key: string) {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 2열 배치 — 그룹을 위에서부터 채워 좌우 높이가 비슷해지게 자른다(신문 단 조판).
  // 펼친 그룹은 담당자 행만큼 높아지므로 그만큼 무게를 더 준다.
  const columnPair = (() => {
    if (!twoCol || !group || groups.length < 4) return null;
    const weight = (g: { key: string; rows: T[] }) =>
      isOpen(g.key) ? 1 + g.rows.length : 1;
    const half = groups.reduce((s, g) => s + weight(g), 0) / 2;
    const left: typeof groups = [];
    const right: typeof groups = [];
    let acc = 0;
    for (const g of groups) {
      if (acc < half) {
        left.push(g);
        acc += weight(g);
      } else right.push(g);
    }
    return right.length ? [left, right] : null;
  })();

  // 묶지 않는 목록(선박·품목처럼 한 줄이 한 건)의 2열 배치. 줄 높이가 고르므로 그냥
  // 반으로 자르면 좌우가 맞는다. 짧은 목록은 자르지 않는다 — 두 동강 난 표가 한 표보다
  // 읽기 나쁘고, 애초에 남는 빈칸도 없다.
  const rowPair = (() => {
    if (!twoCol || group || filtered.length < 8) return null;
    const half = Math.ceil(filtered.length / 2);
    return [filtered.slice(0, half), filtered.slice(half)];
  })();

  // 표 하나. list=null 이면 그룹 없이 행을 그대로 그리고(only 를 주면 그중 일부만 —
  // 2열로 자른 한쪽), 아니면 넘겨받은 그룹만 그린다.
  function table(list: { key: string; rows: T[] }[] | null, only?: T[]) {
    return (
      <table className={`mini wide ms-table${tableClass ? ` ${tableClass}` : ""}`}>
        <thead>
          <tr>
            {columns.map(([key, label, , cls]) => {
              const hc = headByKey.get(String(key));
              // 메뉴가 달린 칸은 누르면 정렬·값 고르기가 열린다(HeadTh). 나머지는 그대로.
              return hc ? (
                <HeadTh
                  key={label}
                  menu={head}
                  col={hc.key}
                  className={cls}
                  numeric={(cls || "").includes("ms-num")}
                >
                  {label}
                </HeadTh>
              ) : (
                <th key={label} className={cls}>{label}</th>
              );
            })}
            <th className="ms-actcol"></th>
          </tr>
        </thead>
        <tbody>
          {!list
            ? (only ?? filtered).map((row) => dataRow(row))
            : // 담당자가 1명이어도 똑같이 회사 행으로 묶는다(줄마다 모양이 달라지지 않게).
              list.map((g) => (
                <Fragment key={g.key}>
                  <tr className="ms-group" onClick={() => toggleGroup(g.key)}>
                    {/* 그룹(회사) 행도 데이터 행과 같은 칸 클래스를 쓴다 — 폭 규칙이
                        한 칸에만 걸리면 열이 들쭉날쭉해진다. */}
                    {group?.cells(g.rows, isOpen(g.key)).map((node, i) => (
                      <td key={i} className={columns[i]?.[3]}>{node}</td>
                    ))}
                    <td className="ms-actcol" onClick={(e) => e.stopPropagation()}>
                      {group?.actions?.(g.rows, () => openNewIn(g.rows),
                        { groups: groupRows, index: groupIndex.get(g.key) ?? 0, editRow: openEdit })}
                    </td>
                  </tr>
                  {isOpen(g.key) ? g.rows.map((row) => dataRow(row, true)) : null}
                </Fragment>
              ))}
        </tbody>
      </table>
    );
  }

  // 데이터 행 1건. sub=true 면 그룹에 속한 하위(담당자) 행 — 첫 칸은 비워 회사명 반복을 없앤다.
  function dataRow(row: T, sub = false) {
    return (
      <tr
        key={row.id}
        className={`${sub ? "ms-sub" : ""}${row.id === editId ? " sel" : ""}`}
        onClick={() => openEdit(row)}
      >
        {columns.map(([key, , renderCell, cls], i) => (
          <td key={String(key)} className={cls}>
            {sub && i === 0
              ? group?.subFirst?.(row) ?? null
              : renderCell
              ? renderCell(row)
              : String(row[key] ?? "") || "—"}
          </td>
        ))}
        <td
          className="ms-actcol"
          onClick={(e) => {
            e.stopPropagation();
            openEdit(row);
          }}
        >
          <span className="ms-edit-btn" title="Edit">
            ✎
          </span>
        </td>
      </tr>
    );
  }

  const editorTitle = isEdit
    ? `✎ Edit ${String(form[required] ?? "") || "item"}`
    : copying
    ? `📋 Copy as new${String(form[required] ?? "") ? ` — ${String(form[required])}` : ""}`
    : "+ New";
  const editor = editId !== null ? (
    <Modal title={editorTitle} onClose={cancel} form>
      {copying && copyHint ? <div className="ms-copy-hint">{copyHint}</div> : null}
      {topForm?.(form, setForm, rows)}
      <div className="form-grid">
        {fields.map(([key, label]) => {
          const custom = renderField?.({ key, label, form, setForm, rows });
          if (custom) return <Fragment key={String(key)}>{custom}</Fragment>;
          return (
            <TextField
              key={String(key)}
              label={label}
              type={numeric.includes(key) ? "number" : "text"}
              value={String(form[key] ?? "")}
              onChange={(v) => setForm({ ...form, [key]: numeric.includes(key) ? Number(v) : v })}
            />
          );
        })}
        {extraForm?.(form, setForm)}
      </div>
      <div className="form-actions">
        {(isEdit ? canEdit : canCreate) ? (
          <button className="btn primary" disabled={!requiredValue} onClick={save}>
            {isEdit ? "Save" : "Add"}
          </button>
        ) : null}
        {isEdit && allowCopy && canCreate ? (
          <button className="btn" onClick={copyAsNew} title="Copy this info into a new record">
            📋 Copy as new
          </button>
        ) : null}
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        {isEdit && canDelete ? (
          <button className="btn danger" onClick={delRow}>
            Delete
          </button>
        ) : null}
        {isEdit && !canEdit ? (
          <span className="hint-inline">View only — your role cannot edit master data.</span>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  ) : null;

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">{title}</h3>
        {group ? (
          <span className="ms-count">{group.summary?.(groups.length, filtered.length)}</span>
        ) : null}
        <input
          className="ms-search"
          placeholder="🔍 Search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {group && groups.length > 0 ? (
          <button
            className="btn"
            onClick={() => setOpenKeys(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
            title={allOpen ? "Collapse all" : "Expand all"}
          >
            {allOpen ? "⊟ Collapse" : "⊞ Expand"}
          </button>
        ) : null}
        {canCreate ? (
          <button className="btn primary" onClick={openNew} disabled={editId === NEW_ID}>
            + New
          </button>
        ) : null}
      </div>

      {editor}

      {/* 머리 칸에 필터가 걸렸을 때만 나오는 줄 — 몇 줄이 남았는지와 한 번에 되돌리기.
          안 걸었으면 자리도 차지하지 않는다. */}
      {head.filtersActive ? (
        <div className="ms-filter-bar">
          <span className="pl-search-count">{filtered.length} / {searched.length}</span>
          <button type="button" className="pl-filter-reset" onClick={head.resetFilters}>
            Reset column filters
          </button>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="state">
          {head.filtersActive ? "No rows match the column filters."
            : ql ? "No search results." : "No items registered."}
        </div>
      ) : columnPair ? (
        // 넓은 화면에서 표가 옆으로 늘어져 빈칸만 커지는 걸 막으려고 좌우 2열로 나눈다.
        <div className="ms-2col">
          {columnPair.map((part, i) => (
            <div key={i} className="table-wrap">
              {table(part)}
            </div>
          ))}
        </div>
      ) : rowPair ? (
        // 같은 이유의 2열 — 이쪽은 묶음이 없어 행을 반씩 나눠 놓는다. 칸이 많은 표는
        // 반으로 갈리면 더 일찍 좁아지므로 한 줄로 되돌리는 폭을 넉넉히 잡는다.
        <div className={`ms-2col${columns.length >= 4 ? " ms-2col--wide" : ""}`}>
          {rowPair.map((part, i) => (
            <div key={i} className="table-wrap">
              {table(null, part)}
            </div>
          ))}
        </div>
      ) : (
        <div className="table-wrap">{table(group ? groups : null)}</div>
      )}
      {/* 열린 열 메뉴는 표 바깥에 띄운다(표 안에 두면 칸 폭에 갇힌다). */}
      {head.renderMenu()}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  /** 브라우저·비밀번호 관리자에게 이 칸이 무엇인지 밝힌다(비밀번호 칸에서 특히 중요). */
  autoComplete?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} />
    </label>
  );
}

function stripId<T extends { id: number }>(row: T): Omit<T, "id"> {
  const { id: _id, ...rest } = row;
  return rest;
}

// ── 이메일 템플릿 편집 탭 (담당자별 초안) ──────────────────────────────────────
// 이메일 종류(doc_type)별 안내 문구. 종류 목록 자체는 서버(EMAIL_DOC_TYPES)가 준다.
const EMAIL_DOC_HINT: Record<string, string> = {
  vendor_rfq:
    "Vendor RFQ 발송 초안(제목·본문)의 기본값입니다. 발송 화면에서는 언제든 다시 편집할 수 있습니다.",
  marketing_intro:
    "Marketing → Compose Email 의 기본값입니다. 수신자 이름은 {{contact}} 자리에 자동으로 채워집니다.",
};

// 서명은 제목·본문 템플릿이 아니라 구조화 필드라서, 종류 탭에 끼워 넣되 편집기는 따로 둔다.
const SIG_TAB = "__signature";

// 여러 줄 칸(이메일·주소 등)은 화면에선 줄바꿈 문자열, 서버로는 배열로 오간다.
type SigForm = Omit<SignatureFields, "emails" | "address" | "tagline" | "services"> & {
  emails: string;
  address: string;
  tagline: string;
  services: string;
};
const toForm = (f: SignatureFields): SigForm => ({
  ...f,
  emails: (f.emails ?? []).join("\n"),
  address: (f.address ?? []).join("\n"),
  tagline: (f.tagline ?? []).join("\n"),
  services: (f.services ?? []).join("\n"),
});
const toFields = (f: SigForm): SignatureFields => {
  const lines = (v: string) =>
    v.split("\n").map((x) => x.trim()).filter(Boolean);
  return {
    ...f,
    emails: lines(f.emails),
    address: lines(f.address),
    tagline: lines(f.tagline),
    services: lines(f.services),
  };
};

// 담당자 서명 편집기 — 칸을 채우면 회사 표준 디자인의 표 서명이 만들어진다.
// 로고까지 전부 텍스트라 수신자가 이미지를 차단해도 연락처가 그대로 보인다.
function SignatureEditor() {
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [form, setForm] = useState<SigForm | null>(null);
  const [saved, setSaved] = useState(false);   // 이 언어에 저장해 둔 표 서명이 있는지
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  // 서명은 담당자별로 저장된다. 관리자는 여기서 담당자를 골라 그 사람 서명을 만들어 둘
  // 수 있고(그 사람이 아직 로그인해 본 적 없어도 발송 화면에서 불러 쓸 수 있다),
  // 그 외 사용자는 본인 것만 편집한다.
  const admin = isAdmin();
  const me = getUser();
  const [users, setUsers] = useState<SettingsUser[]>([]);
  const [pic, setPic] = useState<number>(me?.id ?? 0);

  useEffect(() => {
    if (!admin) return;
    fetchSettingsUsers()
      .then((rows) => setUsers(rows.filter((u) => u.is_active)))
      .catch(() => {
        /* 목록을 못 받으면 본인 서명만 편집한다 — 선택기만 빠진다. */
      });
  }, [admin]);

  const load = useCallback(() => {
    setForm(null);
    fetchEmailSignature(lang, pic || null)
      .then((d) => {
        setForm(toForm(d.fields));
        setSaved(d.has_fields);
        setMsg(null);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, [lang, pic]);
  useEffect(() => load(), [load]);

  // 실시간 미리보기 — 발송에 쓰이는 렌더러를 그대로 태운다(화면 = 수신자가 볼 모습).
  useEffect(() => {
    if (!form) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await previewEmailSignature(lang, toFields(form));
        if (n === seq.current) setHtml(r.html);
      } catch {
        /* 편집 중 일시적 실패는 무시 */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [form, lang]);

  function set<K extends keyof SigForm>(key: K, value: SigForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function doSave() {
    if (!form) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await saveEmailSignature(lang, "", toFields(form), pic || null);
      setSaved(true);
      setMsg(
        pic === (me?.id ?? 0)
          ? "Saved — 이후 모든 발송 화면의 기본 서명이 됩니다."
          : "Saved — 발송 화면의 서명 선택에서 이 담당자를 고르면 불러옵니다."
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    if (!window.confirm("Remove your signature? Sending will fall back to the default."))
      return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await saveEmailSignature(lang, "", null, pic || null);
      setMsg("Removed — 기본 서명으로 돌아갑니다.");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <div className="state">Loading…</div>;

  return (
    <>
      <div className="hint-inline" style={{ marginBottom: 10 }}>
        견적서·발주서·Vendor RFQ·홍보 메일의 서명입니다. 칸을 채우면 회사 표준 디자인으로
        조립되며, 로고까지 전부 텍스트라 수신자가 이미지를 차단해도 그대로 보입니다.
      </div>

      <div className="email-tpl-toolbar">
        {admin && users.length > 1 ? (
          <label className="sig-pic-pick">
            담당자
            <select value={pic} onChange={(e) => setPic(Number(e.target.value))}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                  {u.id === (me?.id ?? 0) ? " (me)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="seg-toggle" role="group" aria-label="Language">
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
          <button className={lang === "ko" ? "on" : ""} onClick={() => setLang("ko")}>KO</button>
        </span>
        <span className={`email-tpl-badge ${saved ? "custom" : "default"}`}>
          {saved ? "Customized" : "Using default"}
        </span>
      </div>

      <div className="email-tpl-split">
        {/* 칸이 짧은 것들은 2~3열로 묶고, 여러 줄이 들어가는 것(이메일·주소·태그라인 등)만
            한 줄을 다 쓴다 — 세로로 길게 늘어놓으면 미리보기와 나란히 보기 어렵다. */}
        <div className="email-tpl-editor sig-form">
          <div className="sub-h">담당자</div>
          <div className="sig-grid">
            <label className="form-field sig-c2">
              <span>Name</span>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="form-field sig-c2">
              <span>Title</span>
              <input value={form.title} onChange={(e) => set("title", e.target.value)} />
            </label>
            <label className="form-field sig-c1">
              <span>Phone label</span>
              <input
                value={form.mobile_label}
                onChange={(e) => set("mobile_label", e.target.value)}
                placeholder="Mobile"
              />
            </label>
            <label className="form-field sig-c1">
              <span>Phone</span>
              <input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} />
            </label>
            <label className="form-field sig-c2">
              <span>Website</span>
              <input value={form.website} onChange={(e) => set("website", e.target.value)} />
            </label>
            <label className="form-field sig-c4">
              <span>Email (한 줄에 하나)</span>
              <textarea rows={2} value={form.emails} onChange={(e) => set("emails", e.target.value)} />
            </label>
            <label className="form-field sig-c4">
              <span>Address (한 줄에 하나)</span>
              <textarea
                rows={2}
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </label>
          </div>

          <div className="sub-h" style={{ marginTop: 14 }}>회사 공통</div>
          <div className="sig-grid">
            <label className="form-field sig-c2">
              <span>Closing</span>
              <input value={form.closing} onChange={(e) => set("closing", e.target.value)} />
            </label>
            <label className="form-field sig-c2">
              <span>Tagline (한 줄에 하나)</span>
              <textarea
                rows={2}
                value={form.tagline}
                onChange={(e) => set("tagline", e.target.value)}
              />
            </label>
            <label className="form-field sig-c2">
              <span>Services (한 줄에 하나)</span>
              <textarea
                rows={2}
                value={form.services}
                onChange={(e) => set("services", e.target.value)}
              />
            </label>
            <label className="form-field sig-c2">
              <span>Disclaimer</span>
              <textarea
                rows={2}
                value={form.disclaimer}
                onChange={(e) => set("disclaimer", e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="email-tpl-preview">
          <div className="sub-h">Preview</div>
          <div className="email-tpl-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>

      <div className="form-actions">
        <button className="btn primary" onClick={doSave} disabled={busy}>
          {busy ? "Working…" : "Save"}
        </button>
        <button className="btn" onClick={doReset} disabled={busy || !saved}>
          Remove signature
        </button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </>
  );
}

function EmailTemplatesTab() {
  const [docType, setDocType] = useState("vendor_rfq");
  const [data, setData] = useState<EmailTemplatesData | null>(null);
  const [scope, setScope] = useState<"user" | "company">("user");
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cols, setCols] = useState<string[]>([]);
  const [customized, setCustomized] = useState(false);
  const [preview, setPreview] =
    useState<{ subject: string; body: string; body_html?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");
  const previewSeq = useRef(0);

  function load(type = docType) {
    if (type === SIG_TAB) return;   // 서명 탭은 자체 편집기가 스스로 불러온다
    fetchEmailTemplates(type)
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  // 종류(RFQ / Company Introduction …)를 바꾸면 그 종류의 템플릿을 다시 불러온다.
  useEffect(() => {
    if (docType === SIG_TAB) return;
    setData(null);
    load(docType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docType]);

  // scope/lang/data 변화 시 해당 템플릿(없으면 기본값)을 폼에 채운다.
  useEffect(() => {
    if (!data) return;
    const src = scope === "company" ? data.company[lang] : data.user[lang];
    if (src) {
      setSubject(src.subject_tpl);
      setBody(src.body_tpl);
      setCols(src.options?.item_cols?.length ? src.options.item_cols : data.default_item_cols);
      setCustomized(true);
    } else {
      setSubject(data.defaults[lang].subject_tpl);
      setBody(data.defaults[lang].body_tpl);
      setCols(data.default_item_cols);
      setCustomized(false);
    }
    setMsg(null);
    setErr(null);
  }, [data, scope, lang]);

  // 실시간 미리보기: 제목·본문·컬럼·언어가 바뀌면 디바운스 후 서버 렌더를 갱신한다.
  // (서버가 샘플 데이터로 토큰/{{item_list}}를 치환하므로 클라이언트 렌더와 항상 일치)
  useEffect(() => {
    if (!data) return;
    const seq = ++previewSeq.current;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const p = await previewEmailTemplate({
          doc_type: data.doc_type,
          lang,
          subject_tpl: subject,
          body_tpl: body,
          options: { item_cols: cols },
        });
        if (seq === previewSeq.current) setPreview(p);
      } catch {
        /* 편집 중 일시적 실패는 조용히 무시 — 다음 입력에서 재시도된다. */
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [data, lang, subject, body, cols]);

  function insertToken(tok: string) {
    const ins = `{{${tok}}}`;
    if (lastFocus.current === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const a = el.selectionStart ?? subject.length;
      const b = el.selectionEnd ?? subject.length;
      setSubject(subject.slice(0, a) + ins + subject.slice(b));
    } else {
      const el = bodyRef.current;
      const a = el?.selectionStart ?? body.length;
      const b = el?.selectionEnd ?? body.length;
      setBody(body.slice(0, a) + ins + body.slice(b));
    }
  }

  function toggleCol(key: string) {
    if (!data) return;
    const order = data.item_cols.map((c) => c.key);
    setCols((prev) => {
      const next = prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key];
      return order.filter((k) => next.includes(k)); // 카탈로그 순서 유지
    });
  }

  async function doSave() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await saveEmailTemplate({
        scope,
        doc_type: docType,
        lang,
        subject_tpl: subject,
        body_tpl: body,
        options: { item_cols: cols },
      });
      setMsg(scope === "company" ? "Saved company default" : "Saved your template");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }
  async function doReset() {
    if (!window.confirm("Reset to default? Your saved template for this language will be removed."))
      return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await deleteEmailTemplate(scope, docType, lang);
      setMsg("Reset to default");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  // 종류 탭은 로딩 중에도 그대로 둔다(탭을 누른 뒤 화면이 통째로 사라지지 않게).
  const typeTabs = (
    <div className="email-tpl-types" role="tablist" aria-label="Email type">
      {(data?.doc_types ?? [{ key: docType, label: "…" }]).map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={docType === t.key}
          className={`email-tpl-type${docType === t.key ? " on" : ""}`}
          onClick={() => setDocType(t.key)}
        >
          {t.label}
        </button>
      ))}
      <button
        type="button"
        role="tab"
        aria-selected={docType === SIG_TAB}
        className={`email-tpl-type${docType === SIG_TAB ? " on" : ""}`}
        onClick={() => setDocType(SIG_TAB)}
      >
        Signature
      </button>
    </div>
  );

  if (docType === SIG_TAB) {
    return (
      <div className="panel email-tpl">
        {typeTabs}
        <SignatureEditor />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel email-tpl">
        {typeTabs}
        <div className="state">Loading…</div>
      </div>
    );
  }

  return (
    <div className="panel email-tpl">
      {typeTabs}
      <div className="hint-inline" style={{ marginBottom: 10 }}>
        {EMAIL_DOC_HINT[data.doc_type] ?? "발송 초안(제목·본문)의 기본값을 담당자별로 설정합니다."}{" "}
        토큰(<code>{`{{${data.tokens[0] ?? "token"}}}`}</code> 등)은 발송 시 실제 값으로 치환됩니다.
      </div>

      <div className="email-tpl-toolbar">
        {data.is_admin ? (
          <span className="seg-toggle" role="group" aria-label="Scope">
            <button className={scope === "user" ? "on" : ""} onClick={() => setScope("user")}>
              My template
            </button>
            <button className={scope === "company" ? "on" : ""} onClick={() => setScope("company")}>
              Company default
            </button>
          </span>
        ) : null}
        <span className="seg-toggle" role="group" aria-label="Language">
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
          <button className={lang === "ko" ? "on" : ""} onClick={() => setLang("ko")}>KO</button>
        </span>
        <span className={`email-tpl-badge ${customized ? "custom" : "default"}`}>
          {customized ? "Customized" : "Using default"}
        </span>
      </div>

      <div className="email-tpl-tokens">
        <span className="email-tpl-tokens-label">Insert token:</span>
        {data.tokens.map((t) => (
          <button key={t} type="button" className="btn xs" onClick={() => insertToken(t)}>
            {`{{${t}}}`}
          </button>
        ))}
      </div>

      <div className="email-tpl-split">
        <div className="email-tpl-editor">
          <div className="form-field" style={{ marginTop: 10 }}>
            <label>Subject</label>
            <input
              ref={subjectRef}
              value={subject}
              onFocus={() => (lastFocus.current = "subject")}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="form-field" style={{ marginTop: 8 }}>
            <label className="email-tpl-body-head">
              Body
              <button
                type="button"
                className="chip-btn md-bold"
                title="선택한 부분을 굵게 (Ctrl+B) — 본문에는 **텍스트** 로 남습니다"
                onClick={() => toggleBold(bodyRef.current, setBody)}
              >
                B
              </button>
            </label>
            <textarea
              ref={bodyRef}
              className="po-textarea"
              style={{ minHeight: 320, fontFamily: "var(--mono)", fontSize: 13, lineHeight: 1.55 }}
              value={body}
              onFocus={() => (lastFocus.current = "body")}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => onBoldKey(e, setBody)}
            />
          </div>

          {/* {{item_list}} 가 있는 종류(Vendor RFQ)에서만 컬럼 선택을 보여준다. */}
          {data.item_cols.length ? (
            <div className="form-field" style={{ marginTop: 8 }}>
              <label>{"ITEM LIST columns  ({{item_list}})"}</label>
              <div className="email-tpl-cols">
                {data.item_cols.map((c) => (
                  <label key={c.key} className="email-tpl-col">
                    <input
                      type="checkbox"
                      checked={cols.includes(c.key)}
                      onChange={() => toggleCol(c.key)}
                    />
                    {lang === "ko" ? c.label_ko : c.label_en}
                    <span className="muted"> ({c.key})</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="email-tpl-preview">
          <div className="sub-h">
            Preview (sample data)
            {previewing ? <span className="email-tpl-preview-live"> · updating…</span> : null}
          </div>
          {preview ? (
            <>
              <div className="email-tpl-preview-subj"><b>Subject:</b> {preview.subject}</div>
              {/* 서버가 발송용 HTML 파트와 같은 렌더러로 만든 조각 — 수신자가 보는
                  그대로다. 구버전 응답(body_html 없음)에서는 평문으로 되돌아간다. */}
              {preview.body_html ? (
                <div
                  className="email-tpl-preview-body"
                  dangerouslySetInnerHTML={{ __html: preview.body_html }}
                />
              ) : (
                <pre className="email-tpl-preview-body plain">{preview.body}</pre>
              )}
            </>
          ) : (
            <div className="muted">Rendering…</div>
          )}
        </div>
      </div>

      <div className="form-actions">
        <button className="btn primary" onClick={doSave} disabled={busy}>
          {busy ? "Working…" : "Save"}
        </button>
        <button className="btn" onClick={doReset} disabled={busy || !customized}>Reset to default</button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

/* ── Mailbox — 회사 메일함 연동 상태 ────────────────────────────────────────
   여기는 **설정**만 본다: 어느 계정을 어떤 주기로 읽고 있는지, 마지막 실행이 무엇을
   했는지, 폴더에 오류가 있는지. 지금 당장 받아 보고 싶을 때 쓰는 Sync 도 함께.

   처리할 것 — 딜을 못 정한 메일(unmatched), 등록되지 않은 상대(unregistered) — 는
   여기 있지 않고 Activity › Mail 에 함께 있다. 둘은 같은 물음("이 메일은 어디로
   가나")의 단계만 다른 일감이라 한 자리에 있어야 하고, 그 일은 설정이 아니라 매일
   하는 작업이라 admin 전용 화면에 가둘 것도 아니다(미등록 상대 함만 admin 전용).
   그래서 이 표는 그리로 가는 문패 두 개를 달아 둔다. */
function MailboxTab() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await fetchMailStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load mailbox status");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 수동 Sync — 자동 실행이 하루 한 번이라, 지금 당장 받아 보고 싶을 때 쓴다.
  async function syncNow() {
    setBusy("sync");
    setErr("");
    setNote("");
    try {
      const r = await syncMail();
      const parts = [`Scanned ${r.scanned}`];
      if (r.stored) parts.push(`kept ${r.stored}`);
      if (r.dup) parts.push(`${r.dup} already stored`);
      if (r.skipped) parts.push(`${r.skipped} from unregistered parties`);
      if (r.auto_matched) parts.push(`auto-matched ${r.auto_matched}`);
      if (r.pending) parts.push(`${r.pending} older mails still unread`);
      setNote(parts.join(" · "));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy("");
    }
  }

  if (!status) return <div className="state">{err || "Loading…"}</div>;

  const auto = status.auto;
  const last = auto.last_result || {};
  const resultParts = (r: Record<string, number | string>) =>
    Object.entries(r || {})
      .filter(([k, v]) => k !== "at" && k !== "error" && k !== "ok" && v)
      .map(([k, v]) => `${k} ${v}`);
  const lastParts = resultParts(last);
  const manual = status.manual || { last_at: "", last_result: {} };
  const manualParts = resultParts(manual.last_result);
  // 폴더별 마지막 오류 — 여기 말고는 "왜 안 들어오나"를 볼 자리가 없다.
  const syncErrors = (status.folders ?? [])
    .filter((f) => f.last_error)
    .map((f) => `${f.folder}: ${f.last_error}`);

  return (
    <div className="panel">
      <h3 className="form-title">Mailbox connection</h3>
      {!status.configured ? (
        <p className="hint-inline" style={{ display: "block", marginBottom: 10 }}>
          The mailbox is not connected. Set <b>IMAP_USER</b> and <b>IMAP_PASSWORD</b> on the
          server (they fall back to SMTP_USER / SMTP_PASSWORD), then press Sync.
        </p>
      ) : null}
      <table className="mini wide">
        <tbody>
          <tr>
            <th style={{ width: 200 }}>Account</th>
            <td>{status.account || "—"} <span className="muted">@ {status.host}</span></td>
          </tr>
          <tr>
            <th>Stored mail</th>
            <td>
              {status.total} kept
              {status.unmatched > 0 ? (
                <> · <a href="/activity?view=mail">{status.unmatched} unmatched</a></>
              ) : null}
            </td>
          </tr>
          {/* 담기지 **않은** 메일의 상대. 처리는 Activity › Mail 에서 하고, 여기서는
              "얼마나 버려지고 있나"만 알려 주고 그리로 보낸다 — 이 표는 설정이지 일감이
              아니다. 0 이면 줄 자체를 내지 않는다(할 일이 없으면 문패도 필요 없다). */}
          {status.unknown > 0 ? (
            <tr>
              <th>Not stored</th>
              <td>
                <a href="/activity?view=mail&queue=unknown">
                  {status.unknown} unregistered counterparts
                </a>
                <span className="muted"> · their mail is discarded until you register, attach, or dismiss them</span>
              </td>
            </tr>
          ) : null}
          <tr>
            <th>Daily run</th>
            <td>
              {auto.enabled ? (
                <>
                  every day at <b>{auto.at}</b> KST
                  {auto.next_run ? <span className="muted"> · next {auto.next_run}</span> : null}
                </>
              ) : (
                <span className="muted">off (MAIL_AUTO_SYNC=0)</span>
              )}
            </td>
          </tr>
          {/* 아침 자동 실행과 사람이 누른 Sync 를 한 줄에 섞지 않는다 — 예전에는 이
              줄이 자동 실행만 가리켜, Sync 를 눌러도 값이 그대로라 아무 일도 안 일어난
              것처럼 보였다. */}
          <tr>
            <th>Last daily run</th>
            <td>
              {auto.running_since ? (
                <b>running now — started {auto.running_since}</b>
              ) : auto.last_run_at ? (
                <>
                  {auto.last_run_at}
                  {lastParts.length ? <span className="muted"> · {lastParts.join(" · ")}</span> : null}
                  {last.error ? <div className="action-err">{String(last.error)}</div> : null}
                </>
              ) : (
                <span className="muted">has not run yet</span>
              )}
            </td>
          </tr>
          <tr>
            <th>Last manual sync</th>
            <td>
              {manual.last_at ? (
                <>
                  {manual.last_at}
                  {manualParts.length ? (
                    <span className="muted"> · {manualParts.join(" · ")}</span>
                  ) : null}
                  {/* 수동 Sync 는 카드 요약을 만들지 않는다 — 브리핑 요약이 비어 있을 때
                      여기를 보고 "동기화는 됐는데 요약이 없구나"를 알 수 있어야 한다. */}
                  <span className="muted"> · digests are written by the daily run</span>
                </>
              ) : (
                <span className="muted">not pressed yet</span>
              )}
            </td>
          </tr>
          {syncErrors.length ? (
            <tr>
              <th>Folder errors</th>
              <td>
                {syncErrors.map((e) => (
                  <div key={e} className="action-err">{e}</div>
                ))}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="form-actions">
        {/* 이미 돌고 있으면 누르게 두지 않는다 — 눌러도 거절만 당한다. */}
        <button
          className="btn"
          onClick={syncNow}
          disabled={!!busy || !status.configured || !!auto.running_since}
        >
          {busy === "sync" || auto.running_since ? "Syncing…" : "↻ Sync now"}
        </button>
        {auto.running_since ? (
          <button className="btn" onClick={load} disabled={!!busy}>
            Refresh status
          </button>
        ) : null}
        <a className="btn" href="/activity?view=mail">Open Mail workspace →</a>
        {note ? <span className="action-ok">{note}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
