import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getUserContact } from "../lib/api";

export function UserContact({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const contact = useQuery({ queryKey: ["user-contact", userId], queryFn: () => getUserContact(userId), enabled: open, retry: false, gcTime: 0 });
  return <div className="user-contact">
    <button type="button" className="secondary-button compact-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? "收起联系方式" : "查看联系方式"}
    </button>
    {open && <section className="contact-card" aria-label="投稿人联系方式">
      {contact.isPending ? <p role="status">正在读取联系方式…</p> : contact.isError ? <p role="alert">无法读取联系方式，请确认账号与权限后重试。</p> : <>
        <p className="muted-note">仅供管理员联系投稿人，请勿公开。</p>
        <dl>
          <div><dt>用户名</dt><dd>{contact.data.username || "未填写"}</dd></div>
          <div><dt>姓名</dt><dd>{contact.data.realName || "未填写"}</dd></div>
          <div><dt>QQ</dt><dd>{contact.data.qq || "未填写"}</dd></div>
          <div><dt>邮箱</dt><dd>{contact.data.email ? <><a href={`mailto:${contact.data.email}`}>{contact.data.email}</a>{!contact.data.emailVerified && "（未验证）"}</> : "未填写"}</dd></div>
          {contact.data.studentIds.map((item,index) => <div key={`${item.attribute}-${index}`}><dt>认证标识（{item.attribute}）</dt><dd>{item.value}</dd></div>)}
        </dl>
      </>}
    </section>}
  </div>;
}
