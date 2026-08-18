import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2, UserRound } from "lucide-react";
import type { ProfileView } from "@urmotiv/contracts";
import {
  ApiError,
  avatarUrlFor,
  deleteMyAvatar,
  getMyProfile,
  updateMyProfile,
  uploadMyAvatar
} from "../lib/api";

const avatarMaxBytes = 512 * 1024;
const allowedAvatarTypes = ["image/jpeg", "image/png", "image/webp"];

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试。";
}

function initialLetter(profile: Pick<ProfileView, "nickname">): string {
  const trimmed = profile.nickname.trim();
  return trimmed ? Array.from(trimmed)[0]! : "?";
}

/** 用昵称哈希为无头像用户分配稳定的底色，避免同姓用户头像混淆。 */
function initialColor(userId: string): string {
  let hash = 0;
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hues = [190, 210, 250, 320, 150, 25];
  return `hsl(${hues[hash % hues.length]}, 45%, 38%)`;
}

type AvatarPreviewProps = {
  profile: ProfileView;
  className?: string;
};

function AvatarPreview({ profile, className = "" }: AvatarPreviewProps) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [profile.avatarUrl]);
  if (profile.avatarUrl && !broken) {
    return (
      <img
        className={`avatar-image ${className}`}
        src={profile.avatarUrl}
        alt=""
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className={`avatar-initial ${className}`}
      data-testid="avatar-initial"
      style={{ background: initialColor(profile.id) }}
    >
      {initialLetter(profile)}
    </span>
  );
}

export function ProfilePage() {
  const idPrefix = useId();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: getMyProfile });
  const [nickname, setNickname] = useState("");
  const [qq, setQq] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const profile = profileQuery.data;

  useEffect(() => {
    if (profile !== undefined) {
      setNickname(profile.nickname);
      setQq(profile.qq ?? "");
    }
  }, [profile]);

  const refreshProfile = () => {
    setUploadError(null);
    return queryClient.invalidateQueries({ queryKey: ["profile"] });
  };

  const saveProfile = useMutation({
    mutationFn: updateMyProfile,
    onSuccess: async () => {
      await refreshProfile();
      await queryClient.invalidateQueries({ queryKey: ["session"], exact: true });
    }
  });

  const setAvatarSource = useMutation({
    mutationFn: (avatarSource: "none" | "qq" | "uploaded") => updateMyProfile({ avatarSource }),
    onSuccess: refreshProfile
  });

  const removeAvatar = useMutation({
    mutationFn: deleteMyAvatar,
    onSuccess: refreshProfile
  });

  const handleUpload = async (file: File) => {
    setUploadError(null);
    const mediaType = file.type.trim().toLowerCase();
    if (!allowedAvatarTypes.includes(mediaType)) {
      setUploadError("只支持 JPEG、PNG 或 WebP 格式的图片。");
      return;
    }
    if (file.size > avatarMaxBytes) {
      setUploadError("头像不能超过 512 KB，请压缩后再试。");
      return;
    }
    setUploading(true);
    try {
      await uploadMyAvatar(file);
      await refreshProfile();
      await queryClient.invalidateQueries({ queryKey: ["session"], exact: true });
    } catch (error) {
      setUploadError(errorMessage(error));
    } finally {
      setUploading(false);
      if (fileInputRef.current !== null) {
        fileInputRef.current.value = "";
      }
    }
  };

  if (profileQuery.isLoading) {
    return <div className="centered-message">正在加载个人资料…</div>;
  }
  if (profileQuery.isError || profile === undefined) {
    return (
      <div className="centered-message error-message">
        <UserRound size={40} aria-hidden="true" />
        <h1>无法加载个人资料</h1>
        <p>{errorMessage(profileQuery.error)}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["profile"] })}
        >
          重试
        </button>
      </div>
    );
  }

  const qqValue = qq.trim();
  const hasUploadedAvatar = profile.avatarSource === "uploaded";
  const canUseQqAvatar = qqValue !== "";
  const nicknameError =
    saveProfile.error instanceof ApiError ? saveProfile.error.fieldErrors?.nickname : undefined;
  const qqError = saveProfile.error instanceof ApiError ? saveProfile.error.fieldErrors?.qq : undefined;

  const submitProfile = (event: React.FormEvent) => {
    event.preventDefault();
    saveProfile.mutate({ nickname, qq: qqValue ? qqValue : null });
  };

  const avatarSourceOptions: Array<{ value: ProfileView["avatarSource"]; label: string; disabled: boolean }> = [
    { value: "none", label: "不使用头像", disabled: false },
    { value: "qq", label: "QQ 头像", disabled: !canUseQqAvatar },
    { value: "uploaded", label: "已上传头像", disabled: !hasUploadedAvatar }
  ];

  return (
    <div className="profile-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">个人资料</p>
          <h1>账号与头像</h1>
          <p>这里维护你的显示昵称、QQ 号码和头像。学号等身份信息来自统一身份认证，只能查看不能修改。</p>
        </div>
      </div>

      {saveProfile.isSuccess ? (
        <div className="notice-line" role="status" data-testid="save-success">
          资料已保存。
        </div>
      ) : null}
      {saveProfile.isError ? (
        <div className="form-error" role="alert">
          保存失败：{errorMessage(saveProfile.error)}
        </div>
      ) : null}
      {setAvatarSource.isError ? (
        <div className="form-error" role="alert">
          {errorMessage(setAvatarSource.error)}
        </div>
      ) : null}
      {removeAvatar.isError ? (
        <div className="form-error" role="alert">
          {errorMessage(removeAvatar.error)}
        </div>
      ) : null}
      {uploadError !== null ? (
        <div className="form-error" role="alert" data-testid="avatar-upload-error">
          {uploadError}
        </div>
      ) : null}

      {profile.accountType === "robot" ? (
        <div className="warning-note" role="status">
          这是机器人账号，不能修改昵称、QQ 号码或头像。
        </div>
      ) : null}

      <section className="form-section" aria-label="个人资料">
        <div className="section-heading">
          <span>1</span>
          <div>
            <h2>基本资料</h2>
            <p>昵称会显示在题目的署名和站点各处。</p>
          </div>
        </div>
        <form className="form-grid" onSubmit={submitProfile} data-testid="profile-form">
          <div className="field">
            <label htmlFor={`${idPrefix}-nickname`}>昵称</label>
            <input
              id={`${idPrefix}-nickname`}
              type="text"
              maxLength={120}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              disabled={profile.accountType !== "human" || saveProfile.isPending}
            />
            {nicknameError ? (
              <span className="inline-error" role="alert">
                {nicknameError[0]}
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-qq`}>QQ 号码（选填）</label>
            <input
              id={`${idPrefix}-qq`}
              type="text"
              inputMode="numeric"
              maxLength={20}
              placeholder="5–11 位数字，用于生成 QQ 头像"
              value={qq}
              onChange={(event) => setQq(event.target.value)}
              disabled={profile.accountType !== "human" || saveProfile.isPending}
            />
            {qqError ? (
              <span className="inline-error" role="alert">
                {qqError[0]}
              </span>
            ) : null}
            <small>QQ 号码只对你自己可见，不会展示给其他用户。</small>
          </div>
          <div className="field wide">
            <label>邮箱</label>
            <input type="text" value={profile.email ?? "（未绑定邮箱）"} readOnly disabled />
            <small>{profile.emailVerified ? "已验证" : "尚未验证"}</small>
          </div>
          {profile.studentIds.length > 0 ? (
            <div className="field wide">
              <label>身份标识（来自统一身份认证）</label>
              <ul className="identifier-list" data-testid="identifier-list">
                {profile.studentIds.map((item) => (
                  <li key={`${item.attribute}:${item.value}`}>
                    <span className="identifier-attribute">{item.attribute}</span>
                    <span className="identifier-value">{item.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="field wide sticky-form-actions">
            <button
              type="submit"
              className="primary-button"
              disabled={profile.accountType !== "human" || saveProfile.isPending}
            >
              {saveProfile.isPending ? "保存中…" : "保存资料"}
            </button>
            {saveProfile.isSuccess ? (
              <span className="notice-line" role="status">
                资料已保存。
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="form-section" aria-label="头像">
        <div className="section-heading">
          <span>2</span>
          <div>
            <h2>头像</h2>
            <p>可以上传图片，也可以直接使用 QQ 头像。图片只接受不超过 512 KB 的 JPEG、PNG 或 WebP。</p>
          </div>
        </div>
        <div className="avatar-editor">
          <div className="avatar-preview-frame">
            <AvatarPreview profile={profile} className="avatar-preview" />
          </div>
          <div className="avatar-source-options" role="radiogroup" aria-label="头像来源">
            {avatarSourceOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`avatar-source-button ${profile.avatarSource === option.value ? "selected" : ""}`}
                role="radio"
                aria-checked={profile.avatarSource === option.value}
                disabled={option.disabled || setAvatarSource.isPending || profile.accountType !== "human"}
                onClick={() => setAvatarSource.mutate(option.value)}
                data-testid={`avatar-source-${option.value}`}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              className="avatar-upload-button"
              disabled={uploading || profile.accountType !== "human"}
              onClick={() => fileInputRef.current?.click()}
              data-testid="avatar-upload-button"
            >
              <ImagePlus size={16} aria-hidden="true" />
              {uploading ? "上传中…" : "上传新头像"}
            </button>
            {hasUploadedAvatar ? (
              <button
                type="button"
                className="avatar-remove-button"
                disabled={removeAvatar.isPending || profile.accountType !== "human"}
                onClick={() => removeAvatar.mutate()}
                data-testid="avatar-remove-button"
              >
                <Trash2 size={16} aria-hidden="true" />
                删除头像
              </button>
            ) : null}
            <input
              ref={fileInputRef}
              className="hidden-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) {
                  void handleUpload(file);
                }
              }}
            />
          </div>
          {!canUseQqAvatar ? (
            <p className="field-help avatar-hint" data-testid="qq-avatar-hint">
              填写 QQ 号码并保存后，就能在右侧选择 QQ 头像。
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}