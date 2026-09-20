import { Component, type ReactNode } from "react";

export class PageLoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <section className="centered-message" role="alert">
        <h2>页面暂时无法加载</h2>
        <p>可能是网络中断或网站刚刚更新，请刷新重试。</p>
        <button
          className="secondary-button"
          onClick={() => window.location.reload()}
        >
          刷新页面
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}
