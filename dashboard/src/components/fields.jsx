import React, { useState } from "react";
import { apiRequest } from "../app/api.js";

export function getValueAtPath(values, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), values);
}

export function setValueAtPath(values, dottedPath, next) {
  const parts = String(dottedPath).split(".");
  const clone = structuredClone(values || {});
  let cursor = clone;
  while (parts.length > 1) cursor = cursor[parts.shift()] ||= {};
  cursor[parts[0]] = next;
  return clone;
}

function TemplateField({ field, value, onChange }) {
  const [preview, setPreview] = useState("");
  const runPreview = async () => {
    try {
      const result = await apiRequest("/api/commands/render-preview", {
        method: "POST",
        body: { template: value || "", vars: { prefix: "!", command: "tenlenh", user: "NgườiDùng", userId: "000000", thread: "NhómMẫu", remaining: "30", reason: "ví dụ", params: { example: 1 } } },
      });
      setPreview(result.data?.rendered ?? "(trống — sẽ dùng message mặc định)");
    } catch (error) {
      setPreview(`Lỗi preview: ${error.message}`);
    }
  };
  return (
    <label className="field field-template">
      <span>{field.label}</span>
      <textarea rows="2" value={value || ""} placeholder={field.help || ""} onChange={(e) => onChange(e.target.value)} />
      <small className="muted">{field.help}</small>
      <div className="toolbar">
        <button className="secondary" type="button" onClick={runPreview}>Xem trước</button>
        {preview ? <code className="preview-box">{preview}</code> : null}
      </div>
    </label>
  );
}

function TableField({ field, rows, onChange }) {
  const updateRow = (index, columnKey, cellValue) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [columnKey]: cellValue } : row));
    onChange(next);
  };
  return (
    <div className="field field-table">
      <div className="field-head">
        <span>{field.label}</span>
        <button className="secondary" type="button" onClick={() => onChange([...rows, Object.fromEntries(field.columns.map((c) => [c.key, ""]))])}>+ Thêm dòng</button>
      </div>
      {rows.length ? (
        <table className="editable-table">
          <thead><tr>{field.columns.map((col) => <th key={col.key}>{col.label}</th>)}<th /></tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {field.columns.map((col) => (
                  <td key={col.key}>
                    {col.control === "select" ? (
                      <select value={row[col.key] ?? ""} onChange={(e) => updateRow(index, col.key, e.target.value)}>
                        <option value="">—</option>
                        {(col.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input type={col.type === "number" ? "number" : "text"} value={row[col.key] ?? ""} onChange={(e) => updateRow(index, col.key, col.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />
                    )}
                  </td>
                ))}
                <td><button className="secondary danger" type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Xoá</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">{field.help || "Chưa có dòng nào."}</p>}
    </div>
  );
}

export function SchemaField({ field, values, onChange }) {
  const value = getValueAtPath(values, field.key);
  const update = (next) => onChange(setValueAtPath(values, field.key, next));

  if (field.type === "table") return <TableField field={field} rows={Array.isArray(value) ? value : []} onChange={update} />;
  if (field.type === "template") return <TemplateField field={field} value={value} onChange={update} />;
  if (field.type === "select") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select value={value ?? ""} onChange={(e) => update(e.target.value)}>
          {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
        <small className="muted">{field.help}</small>
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <input type="number" min={field.min} max={field.max} value={value ?? ""} placeholder={field.nullable ? "(trống = dùng mặc định)" : ""} onChange={(e) => update(e.target.value === "" ? (field.nullable ? null : 0) : Number(e.target.value))} />
        <small className="muted">{field.help}</small>
      </label>
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="field field-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => update(e.target.checked)} />
        <span>{field.label}</span>
        {field.help ? <small className="muted">{field.help}</small> : null}
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}</span>
      <input type="text" value={value ?? ""} maxLength={field.type === "emoji" ? 8 : undefined} onChange={(e) => update(e.target.value)} />
      {field.help ? <small className="muted">{field.help}</small> : null}
    </label>
  );
}

export function SchemaGroup({ group, values, onChange }) {
  return (
    <div className={`schema-group schema-group-${group.id}`}>
      <h4>{group.label}</h4>
      <div className="form-grid">
        {group.fields.map((field) => <SchemaField key={field.key} field={field} values={values} onChange={onChange} />)}
      </div>
    </div>
  );
}

export function SchemaFields({ schemaGroups, values, onChange }) {
  return (
    <div className="schema-fields">
      {(schemaGroups || []).map((group) => <SchemaGroup key={group.id} group={group} values={values} onChange={onChange} />)}
    </div>
  );
}
