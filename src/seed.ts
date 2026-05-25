import { ManagementProfile } from "./types.ts";
import { upsertSeedTeam } from "./store.ts";

const samples: Array<{
  group_name: string;
  dept_path: string;
  manager_shadow_id: string;
  metrics_snapshot: ManagementProfile;
  tags: string[];
  summaries: string[];
  major_events?: Array<{
    occurred_at: string;
    brief: string;
    source_title?: string;
    source_url?: string;
  }>;
}> = [
  {
    group_name: "tr:X",
    dept_path: "基础架构 / 边缘平台",
    manager_shadow_id: "MGR-BJ-0891",
    metrics_snapshot: {
      transparency: 7.8,
      autonomy: 7.1,
      psychological_safety: 6.9,
      feedback_loop: 8.2,
      wlb_boundary: 5.7,
      growth_support: 8.0,
    },
    tags: ["技术导向", "反馈频繁", "节奏偏快", "成长支持"],
    summaries: [
      "团队以技术结果和交付质量为核心，反馈节奏较快，适合希望快速成长且能接受较高强度的成员。",
      "主管倾向明确目标与频繁校准，授权空间随个人成熟度提升而增加。",
    ],
    major_events: [
      {
        occurred_at: "2026-04-15",
        brief: "平台目标切换为交付稳定性优先，反馈频率和排期压力同步上升。",
        source_title: "公开产品路线更新",
        source_url: "https://example.com/public-roadmap-update",
      },
    ],
  },
  {
    group_name: "tr:Y",
    dept_path: "云产品 / 开发者体验",
    manager_shadow_id: "MGR-SZ-1204",
    metrics_snapshot: {
      transparency: 8.4,
      autonomy: 8.0,
      psychological_safety: 8.2,
      feedback_loop: 7.1,
      wlb_boundary: 7.8,
      growth_support: 7.5,
    },
    tags: ["边界清晰", "授权充分", "决策透明", "稳定节奏"],
    summaries: [
      "团队整体节奏较稳定，目标拆解清晰，管理者更偏向授权和定期同步。",
      "适合重视工作边界、希望在稳定产品方向中积累长期影响力的成员。",
    ],
    major_events: [
      {
        occurred_at: "2026-03-15",
        brief: "团队调整为长期产品维护模式，工作边界和授权稳定性明显改善。",
      },
    ],
  },
  {
    group_name: "tr:Z",
    dept_path: "电商技术 / 增长实验",
    manager_shadow_id: "MGR-HZ-4420",
    metrics_snapshot: {
      transparency: 6.2,
      autonomy: 5.8,
      psychological_safety: 5.9,
      feedback_loop: 7.4,
      wlb_boundary: 4.8,
      growth_support: 6.9,
    },
    tags: ["结果导向", "高强度节奏", "目标频繁", "资源竞争"],
    summaries: [
      "团队目标导向明显，业务节奏变化较快，对主动推进和抗压能力要求较高。",
      "管理风格强调结果闭环，资源支持与反馈频率较高，但工作边界存在波动。",
    ],
    major_events: [
      {
        occurred_at: "2026-02-15",
        brief: "增长目标上调后评审周期缩短，工作节奏和目标变更频率明显提高。",
      },
    ],
  },
  {
    group_name: "tr:Lab",
    dept_path: "AI Agent / Product Engineering",
    manager_shadow_id: "MGR-SH-7712",
    metrics_snapshot: {
      transparency: 7.2,
      autonomy: 8.6,
      psychological_safety: 7.7,
      feedback_loop: 6.5,
      wlb_boundary: 6.8,
      growth_support: 8.4,
    },
    tags: ["高授权", "探索型", "技术导向", "成长支持"],
    summaries: [
      "团队处于探索阶段，授权空间大，适合偏自驱、能在不确定环境中主动定义问题的成员。",
      "管理者重视技术判断和产品试错，对沟通主动性和跨职能协作要求较高。",
    ],
    major_events: [
      {
        occurred_at: "2026-05-15",
        brief: "产品方向从外包交付转向自研探索，授权空间和试错容忍度明显提升。",
        source_title: "公开产品方向披露",
        source_url: "https://example.com/public-product-direction",
      },
    ],
  },
];

for (const sample of samples) {
  const id = await upsertSeedTeam(sample);
  console.log(`seeded ${sample.group_name} / ${sample.dept_path}: ${id}`);
}

console.log("Seed completed.");
