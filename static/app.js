const DIMENSIONS = [
  ["transparency", "决策透明"],
  ["autonomy", "授权空间"],
  ["psychological_safety", "心理安全"],
  ["feedback_loop", "反馈频率"],
  ["wlb_boundary", "工作边界"],
  ["growth_support", "成长支持"],
];

const APP_CONFIG = {
  edition: "public",
  org_label: "公司名称",
  org_field: "group_name",
  org_placeholder: "例如 Tencent",
};

async function loadAppConfig() {
  try {
    const response = await fetch("/api/health");
    const config = await response.json();
    if (response.ok) Object.assign(APP_CONFIG, config);
  } catch {
    // 使用默认公开版配置。
  }
}

function orgValue(team) {
  return team.group_name || "未知事业群";
}

class StyleRadarChart extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.canvas = document.createElement("canvas");
    this.canvas.width = 440;
    this.canvas.height = 440;
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; width:100%; aspect-ratio:1; }
      canvas { width:100%; height:100%; display:block; }
    `;
    this.shadowRoot.append(style, this.canvas);
  }

  set data(value) {
    this._data = value || {};
    this.draw();
  }

  connectedCallback() {
    this.draw();
  }

  draw() {
    const ctx = this.canvas.getContext("2d");
    const width = this.canvas.width;
    const height = this.canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = 150;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "rgba(255, 252, 244, 0.45)";
    ctx.beginPath();
    ctx.arc(cx, cy, 180, 0, Math.PI * 2);
    ctx.fill();

    for (let ring = 1; ring <= 5; ring++) {
      ctx.beginPath();
      DIMENSIONS.forEach((_, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / DIMENSIONS.length;
        const r = radius * ring / 5;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = `rgba(28, 26, 23, ${0.08 + ring * 0.025})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    DIMENSIONS.forEach(([, label], index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / DIMENSIONS.length;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.strokeStyle = "rgba(28, 26, 23, 0.12)";
      ctx.stroke();

      ctx.fillStyle = "#6e675d";
      ctx.font = "600 20px Avenir Next, sans-serif";
      ctx.textAlign = Math.cos(angle) > 0.2 ? "left" : Math.cos(angle) < -0.2 ? "right" : "center";
      ctx.textBaseline = Math.sin(angle) > 0.2
        ? "top"
        : Math.sin(angle) < -0.2
        ? "bottom"
        : "middle";
      ctx.fillText(
        label,
        cx + Math.cos(angle) * radius,
        cy + Math.sin(angle) * radius,
      );
    });

    ctx.beginPath();
    DIMENSIONS.forEach(([key], index) => {
      const score = Math.max(1, Math.min(10, Number(this._data?.[key] ?? 1)));
      const angle = -Math.PI / 2 + index * Math.PI * 2 / DIMENSIONS.length;
      const r = radius * score / 10;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    const gradient = ctx.createLinearGradient(90, 60, 330, 330);
    gradient.addColorStop(0, "rgba(217, 79, 39, 0.72)");
    gradient.addColorStop(1, "rgba(10, 109, 115, 0.58)");
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = "rgba(28, 26, 23, 0.78)";
    ctx.lineWidth = 3;
    ctx.stroke();

    DIMENSIONS.forEach(([key], index) => {
      const score = Math.max(1, Math.min(10, Number(this._data?.[key] ?? 1)));
      const angle = -Math.PI / 2 + index * Math.PI * 2 / DIMENSIONS.length;
      const r = radius * score / 10;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#fff7e8";
      ctx.fill();
      ctx.strokeStyle = "#1c1a17";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

class AnonymousReviewCard extends HTMLElement {
  set team(team) {
    this._team = team;
    this._timeline = [];
    this._events = [];
    this._eventsLoaded = false;
    this.render();
  }

  render() {
    const team = this._team;
    if (!team) return;
    const summaries = team.safe_summaries?.length ? team.safe_summaries : ["暂无安全摘要。"];
    this.innerHTML = `
      <article class="team-card">
        <div class="radar-column">
          <style-radar-chart></style-radar-chart>
          <button class="timeline-button" type="button" aria-expanded="false" aria-label="展开变化时间线">
            <span class="clock-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-clock" viewBox="0 0 16 16">
  <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z"/>
  <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0"/>
</svg></span>
          </button>
        </div>
        <div class="card-info">
          <h3 class="card-title">${escapeHtml(orgValue(team))}</h3>
          <div class="card-meta">
            ${escapeHtml(team.dept_path)}<br />
            ${
      escapeHtml(team.manager_shadow_id)
    } · <span data-review-count>${team.review_count}</span> 个安全样本<br />
            <span data-state-at>${
      formatEventDate(team.latest_timeline_at || team.updated_at)
    }</span>
          </div>
          <div class="tag-row" data-tags>
            ${
      (team.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")
    }
          </div>
          <div class="summary-list" data-summaries>
            ${summaries.map((summary) => `<p>${escapeHtml(summary)}</p>`).join("")}
          </div>
          <div class="card-actions">
            ${
      team.match_score !== undefined
        ? `<span class="metric-badge">匹配度 ${Math.round(team.match_score * 100)}%</span>`
        : ""
    }
          </div>
        </div>
        <div class="timeline-panel" hidden>
          <p class="timeline-hint">选择任一周，雷达图与摘要会切换到当周公开状态</p>
          <div class="timeline-list"></div>
        </div>
      </article>
    `;
    this.applyState(team);
    this.querySelector(".timeline-button").addEventListener("click", () => this.toggleTimeline());
  }

  applyState(state) {
    this.querySelector("style-radar-chart").data = state.metrics_snapshot;
    this.querySelector("[data-review-count]").textContent = state.review_count;
    this.querySelector("[data-state-at]").textContent = formatEventDate(
      state.at || state.latest_timeline_at || state.updated_at,
    );
    this.querySelector("[data-tags]").innerHTML = (state.tags || [])
      .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
      .join("");
    const summaries = state.safe_summary ? [state.safe_summary] : state.safe_summaries || [];
    this.querySelector("[data-summaries]").innerHTML = summaries
      .map((summary) => `<p>${escapeHtml(summary)}</p>`)
      .join("");
  }

  resetState() {
    this.applyState(this._team);
    this.querySelectorAll(".timeline-point").forEach((button) => button.classList.remove("active"));
  }

  async toggleTimeline() {
    const panel = this.querySelector(".timeline-panel");
    const button = this.querySelector(".timeline-button");
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    button.classList.toggle("open", willOpen);

    if (!willOpen) {
      this.resetState();
      return;
    }

    if (this._timeline.length) return;

    const list = this.querySelector(".timeline-list");
    list.innerHTML = `<span class="timeline-loading">正在读取历史状态…</span>`;

    try {
      const response = await fetch(`/api/v1/teams/${this._team.team_id}/timeline`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "时间线加载失败");
      this._timeline = result.timeline || [];
      this.renderTimeline();
    } catch (error) {
      list.innerHTML = `<span class="timeline-loading">${escapeHtml(error.message)}</span>`;
    }
  }

  renderTimeline() {
    const list = this.querySelector(".timeline-list");
    if (!this._timeline.length) {
      list.innerHTML = `<span class="timeline-loading">暂无历史时间点。</span>`;
      return;
    }

    list.innerHTML = this._timeline.map((point, index) => `
      <div class="timeline-item">
        <button class="timeline-point" type="button" data-index="${index}">
          ${formatEvent(point.event) ? `<span>${formatEvent(point.event)}</span>` : ""}
          <strong>${formatEventDate(point.at)}</strong>
          <small>${point.review_count} 个样本 · ${
      (point.tags || []).slice(0, 2).map(escapeHtml).join(" / ")
    }</small>
        </button>
        ${
      Number(point.major_event_count || 0) > 0
        ? `
          <button class="week-event-toggle" type="button" data-week-index="${index}" aria-expanded="false" aria-label="展开该周重大影响事件" title="${point.major_event_count} 个影响事件">
            <span class="broadcast-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-broadcast" viewBox="0 0 16 16">
  <path d="M3.05 3.05a7 7 0 0 0 0 9.9.5.5 0 0 1-.707.707 8 8 0 0 1 0-11.314.5.5 0 0 1 .707.707m2.122 2.122a4 4 0 0 0 0 5.656.5.5 0 1 1-.708.708 5 5 0 0 1 0-7.072.5.5 0 0 1 .708.708m5.656-.708a.5.5 0 0 1 .708 0 5 5 0 0 1 0 7.072.5.5 0 1 1-.708-.708 4 4 0 0 0 0-5.656.5.5 0 0 1 0-.708m2.122-2.12a.5.5 0 0 1 .707 0 8 8 0 0 1 0 11.313.5.5 0 0 1-.707-.707 7 7 0 0 0 0-9.9.5.5 0 0 1 0-.707zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0"/>
</svg></span>
          </button>
        `
        : ""
    }
        <div class="week-events" data-week-events="${index}" hidden></div>
      </div>
    `).join("");

    list.querySelectorAll(".timeline-point").forEach((button) => {
      button.addEventListener("click", () => {
        list.querySelectorAll(".timeline-point").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        const index = Number(button.dataset.index);
        this.applyState(this._timeline[index]);
      });
    });

    list.querySelectorAll(".week-event-toggle").forEach((button) => {
      button.addEventListener("click", () => this.toggleWeekEvents(button));
    });
  }

  async toggleWeekEvents(button) {
    const panel = this.querySelector(`[data-week-events="${button.dataset.weekIndex}"]`);
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    button.classList.toggle("open", willOpen);
    if (!willOpen) return;

    panel.innerHTML = `<span class="timeline-loading">正在读取公开重大影响事件…</span>`;
    try {
      if (!this._eventsLoaded) await this.loadEvents();
      const point = this._timeline[Number(button.dataset.weekIndex)];
      const events = this.eventsForWeek(point.at);
      panel.innerHTML = events.length
        ? events.map((event) => `
          <article class="major-event">
            <time>${formatEventDate(event.occurred_at)}</time>
            <p>${escapeHtml(event.brief)}</p>
            <small>${eventSourceLink(event)}记录于 ${formatTime(event.recorded_at)}</small>
          </article>
        `).join("")
        : `<span class="timeline-loading">该周暂无公开来源重大影响事件。</span>`;
    } catch (error) {
      panel.innerHTML = `<span class="timeline-loading">${escapeHtml(error.message)}</span>`;
    }
  }

  async loadEvents() {
    const response = await fetch(`/api/v1/teams/${this._team.team_id}/events`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "重大事件加载失败");
    this._events = result.events || [];
    this._eventsLoaded = true;
  }

  eventsForWeek(week) {
    return (this._events || []).filter((event) => eventMatchesWeek(event.occurred_at, week));
  }
}

class GiveTakeModal extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="modal-shell" role="dialog" aria-modal="true" aria-label="匿名贡献">
        <section class="modal-card">
          <div class="modal-head">
            <div>
              <p class="eyebrow">Give & Take</p>
              <h3>贡献一段匿名经历，解锁更多团队视角。</h3>
            </div>
            <button class="close-button" type="button" aria-label="关闭">×</button>
          </div>
          <form id="contribute-form" class="form-grid">
            <label data-org-label>${escapeHtml(APP_CONFIG.org_label)}
              <input data-org-input name="${
      escapeHtml(APP_CONFIG.org_field)
    }" required maxlength="80" placeholder="${escapeHtml(APP_CONFIG.org_placeholder)}" />
            </label>
            <label>团队 / 部门路径
              <input name="dept_path" required maxlength="120" placeholder="例如 云产品 / 开发者体验" />
            </label>
            <label class="full">匿名邮箱（仅哈希后用于防刷）
              <input name="email" type="email" required placeholder="you@example.com" />
            </label>
            <label class="full">评价文本
              <textarea name="raw_content" required minlength="20" maxlength="4000" placeholder="请描述管理风格、沟通方式、授权空间、工作边界等。不要填写真实姓名、手机号、微信号或具体项目机密。"></textarea>
            </label>
            <button class="submit-button" type="submit">提交到影子缓冲</button>
          </form>
          <p class="status-line" id="modal-status">提交后将由配置的 LLM 脱敏，随机延迟发布；样本量 N&lt;3 不公开。</p>
        </section>
      </div>
    `;
    this.shell = this.querySelector(".modal-shell");
    this.querySelector(".close-button").addEventListener("click", () => this.close());
    this.shell.addEventListener("click", (event) => {
      if (event.target === this.shell) this.close();
    });
    this.querySelector("#contribute-form").addEventListener(
      "submit",
      (event) => this.submit(event),
    );
  }

  open() {
    this.shell.setAttribute("open", "");
  }
  close() {
    this.shell.removeAttribute("open");
  }

  async submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = this.querySelector("#modal-status");
    const button = form.querySelector("button[type='submit']");
    const data = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    status.textContent = "正在调用配置的 LLM 进行脱敏与结构化，请稍候…";

    try {
      const reviewResponse = await fetch("/api/v1/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const reviewResult = await reviewResponse.json();
      if (!reviewResponse.ok) throw new Error(reviewResult.error || "提交失败");

      await fetch("/api/v1/access-grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email }),
      });

      form.reset();
      status.textContent = "已进入影子缓冲。公开结果会在随机延迟和 N≥3 后更新。";
    } catch (error) {
      status.textContent = error.message.includes("DEEPSEEK_API_KEY")
        ? "服务端尚未配置 DEEPSEEK_API_KEY；可改用 LLM_PROVIDER=ollama 或设置 LLM_MOCK=1。"
        : error.message;
    } finally {
      button.disabled = false;
    }
  }
}

customElements.define("style-radar-chart", StyleRadarChart);
customElements.define("anonymous-review-card", AnonymousReviewCard);
customElements.define("give-take-modal", GiveTakeModal);

const grid = document.querySelector("#team-grid");
const empty = document.querySelector("#empty-state");
const modal = document.querySelector("give-take-modal");

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[char]));
}

function eventSourceLink(event) {
  if (!event.source_url) {
    return event.source_title ? `${escapeHtml(event.source_title)} · ` : "公开来源 · ";
  }
  const title = event.source_title || "公开来源";
  return `<a href="${escapeHtml(event.source_url)}" target="_blank" rel="noreferrer">${
    escapeHtml(title)
  }</a> · `;
}

function formatTime(value) {
  if (!value) return "暂无时间点";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toWeekBucket(value) {
  if (!value) return "";
  if (/^\d{4}-W\d{2}$/i.test(value)) return value.toUpperCase();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weekMonth(week) {
  const match = String(week).match(/^(\d{4})-W(\d{2})$/i);
  if (!match) return "";
  const year = Number(match[1]);
  const weekNo = Number(match[2]);
  const date = new Date(Date.UTC(year, 0, 1 + (weekNo - 1) * 7));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function eventMatchesWeek(eventAt, week) {
  if (!eventAt || !week) return false;
  const normalized = String(eventAt).toUpperCase();
  if (/^\d{4}-W\d{2}$/.test(normalized)) return normalized === week.toUpperCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return toWeekBucket(normalized) === week.toUpperCase();
  }
  if (/^\d{4}-\d{2}$/.test(normalized)) return normalized === weekMonth(week);
  return false;
}

function formatEventDate(value) {
  if (!value) return "未知时间";
  if (/^\d{4}-W\d{2}$/i.test(value)) {
    const [year, week] = value.toUpperCase().split("-W");
    return `${year} 年第 ${Number(week)} 周`;
  }
  if (/^\d{4}-\d{2}$/.test(value)) return value.replace("-", " 年 ") + " 月";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return formatTime(value);
}

function formatEvent(event) {
  return {
    activated: "达到安全阈值",
    review_merged: "合并新样本",
    seed_snapshot: "",
  }[event] || "状态更新";
}

async function loadTeams(params = {}) {
  const url = new URL("/api/v1/teams", location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });

  grid.innerHTML = "";
  empty.hidden = true;

  try {
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "加载失败");

    const teams = result.teams || [];
    empty.hidden = teams.length > 0;
    teams.forEach((team, index) => {
      const card = document.createElement("anonymous-review-card");
      card.style.animationDelay = `${index * 70}ms`;
      card.team = team;
      grid.append(card);
    });
  } catch (error) {
    empty.hidden = false;
    empty.textContent = error.message;
  }
}

document.querySelector("#open-contribute").addEventListener("click", () => modal.open());
document.querySelector("#refresh").addEventListener("click", () => loadTeams());
document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadTeams({ q: document.querySelector("#search-input").value.trim() });
});
document.querySelectorAll(".quick-tags button").forEach((button) => {
  button.addEventListener("click", () => loadTeams({ tag: button.dataset.tag }));
});

await loadAppConfig();
if (modal?.connectedCallback) modal.connectedCallback();
loadTeams();
