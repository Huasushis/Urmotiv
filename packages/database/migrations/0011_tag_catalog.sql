CREATE TYPE "tag_item_kind" AS ENUM ('category', 'tag');
--> statement-breakpoint
ALTER TABLE "tags"
  ADD COLUMN "item_kind" "tag_item_kind",
  ADD COLUMN "normalized_name" varchar(160);
--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM tags WHERE parent_id IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_LEGACY_TREE_UNSUPPORTED';
  END IF;
  IF EXISTS (SELECT 1 FROM tags WHERE id LIKE 'catalog.%' OR id LIKE 'legacy.category.%') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_STABLE_ID_CONFLICT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tags
    WHERE id !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_STABLE_ID_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tags
    WHERE length(regexp_replace(
      normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    )) = 0
      OR length(regexp_replace(
        normalize(group_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
      )) = 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_NORMALIZED_NAME_CONFLICT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tags
    GROUP BY lower(regexp_replace(
      normalize(group_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    ))
    HAVING count(DISTINCT group_name) > 1
  ) OR EXISTS (
    SELECT 1
    FROM tags
    GROUP BY
      lower(regexp_replace(
        normalize(group_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
      )),
      lower(regexp_replace(
        normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
      ))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_NORMALIZED_NAME_CONFLICT';
  END IF;
END
$migration$;
--> statement-breakpoint
UPDATE tags
SET item_kind = 'tag',
    normalized_name = lower(regexp_replace(
      normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    ));
--> statement-breakpoint
WITH legacy_groups AS (
  SELECT
    group_name,
    regexp_replace(
      normalize(group_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    ) AS display_name,
    lower(regexp_replace(
      normalize(group_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    )) AS normalized_group_name,
    min(created_at) AS created_at,
    max(updated_at) AS updated_at
  FROM tags
  GROUP BY group_name
), legacy_categories AS (
  SELECT
    group_name,
    normalized_group_name,
    left(display_name, 60)
      || '（旧分组 ' || left(md5(normalized_group_name), 8) || '）' AS category_name,
    created_at,
    updated_at
  FROM legacy_groups
)
INSERT INTO tags (
  id, parent_id, name, normalized_name, item_kind, group_name, description,
  sort_order, is_active, created_by_user_id, created_at, updated_at
)
SELECT
  'legacy.category.' || md5(normalized_group_name),
  NULL,
  category_name,
  lower(regexp_replace(
    normalize(category_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
  )),
  'category',
  group_name,
  '0011 迁移保留的旧分组',
  row_number() OVER (ORDER BY normalized_group_name, group_name) - 1,
  true,
  NULL,
  created_at,
  updated_at
FROM legacy_categories;
--> statement-breakpoint
UPDATE tags leaf
SET parent_id = 'legacy.category.' || md5(lower(regexp_replace(
  normalize(leaf.group_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
)))
WHERE leaf.item_kind = 'tag';
--> statement-breakpoint
WITH catalog(category_order, category_name, tag_names) AS (
  VALUES
    (1, '基础', ARRAY['变量操作','分支结构','循环结构','一维数组','函数','结构体','位运算','选择题','字符串','二维数组','指针','引用','宏定义','联合体','类型相关','turtle','代码组织','代码调试','格式化输入输出']::text[]),
    (2, '基础算法', ARRAY['排序','贪心','递推','递归','分治','二分','高精度','暴力/枚举','模拟','进制转换','序计数','基数排序','归并排序']::text[]),
    (3, '搜索', ARRAY['深搜/宽搜','剪枝','记忆化搜索','启发式搜索','A*','Dancing Links','迭代加深搜索','双向bfs']::text[]),
    (4, '动态规划', ARRAY['动态规划基础 (DP)','区间 DP','树形 DP','插头 DP','数位 DP','动态 DP','概率 DP','状态压缩','DP 优化','单调栈/单调队列优化','四边形不等式','斜率优化','矩阵优化','背包问题','最长公共子序列（LCS）','最长上升子序列（LIS）','环形 DP']::text[]),
    (5, '字符串', ARRAY['字符串匹配','字符串哈希','字典树','KMP','扩展 KMP','后缀数组','后缀自动机','后缀树','AC 自动机','有限状态自动机','回文自动机','Manacher 算法','最小表示法']::text[]),
    (6, '计算几何', ARRAY['计算几何','立体解析几何','凸包','叉积','线段相交','点积','半平面交','凸多边形的交','扫描线','旋转卡壳']::text[]),
    (7, '数据结构', ARRAY['栈','队列','链表','哈希表','并查集','堆/优先队列','分块','单调栈/单调队列','ST表','树状数组','线段树','李超线段树','二叉搜索树/平衡树','可持久化','树套树','K-DTree','动态树 (LCT)','STL','线段树合并','树分块','数据结构','线段树分治']::text[]),
    (8, '树上问题', ARRAY['LCA','树的重心','树链剖分','树上启发式合并','RMQ','基环树','笛卡尔树','虚树','点分治','树分治','动态树分治','树','二叉树','哈夫曼树','树的直径','换根','ODT','主席树','DFS 序','树上倍增']::text[]),
    (9, '图论', ARRAY['拓扑排序','最小生成树','图遍历','Kruskal 重构树','网络流','最短路','最小环','平面图','2-SAT','欧拉公式','强连通分量','双连通分量','割点和桥','欧拉回路','差分约束','二分图','费用流','图','矩阵树定理','最小割','DAG','分层图','图论','建图优化','次小生成树','Floyd','Dijkstra','SPFA','二分图匹配']::text[]),
    (10, '博弈论', ARRAY['Sg 函数','Nim 博弈','博弈论']::text[]),
    (11, '群论', ARRAY['群论','置换','Polya 原理']::text[]),
    (12, '其他技巧', ARRAY['离散化','双指针','分数规划','模拟退火','构造','倍增','三分','CDQ 分治','整体二分','莫队','差分/前缀和','bitset','根号分治','折半搜索/中途相遇法','随机化']::text[]),
    (13, '数学', ARRAY['数学','筛法','概率/期望','卷积','数论分块','杜教筛','Dirichlet 前缀和','Dirichlet 后缀和']::text[]),
    (14, '多项式', ARRAY['FFT','NTT','FWT','FMT','拉格朗日插值']::text[]),
    (15, '数论', ARRAY['原根','质数判断','gcd','扩展欧几里得','中国剩余定理','莫比乌斯反演','逆元','Lucas 定理','欧拉函数','欧拉降幂公式','BSGS','乘性函数','快速幂']::text[]),
    (16, '组合数学', ARRAY['组合数学','二项式定理','康托展开','鸽笼原理','容斥','卡特兰数','斯特林数','生成函数','拉格朗日反演','霍尔定理','二项式反演']::text[]),
    (17, '概率论', ARRAY['概率论']::text[]),
    (18, '线性代数', ARRAY['线性代数','LGV 引理','矩阵','高斯消元','线性基']::text[]),
    (19, '微积分', ARRAY['微积分']::text[]),
    (20, '初赛', ARRAY['计算机常识','计算机硬件系统','计算机软件系统','计算机网络','原码补码反码','流程图','伪代码','信息编码表示','文件操作','异常','单位换算','计算机语言','逻辑推理','时空复杂度','竞赛历史','逻辑运算','面向对象','表达式转换']::text[]),
    (21, '交互', ARRAY['交互']::text[]),
    (22, '其他', ARRAY['通信','二进制','wqs二分','离线处理','计数','反悔贪心','逆序对','贡献']::text[])
), categories AS (
  INSERT INTO tags (
    id, parent_id, name, normalized_name, item_kind, group_name, description,
    sort_order, is_active, created_by_user_id
  )
  SELECT
    'catalog.category.' || lpad(category_order::text, 2, '0'),
    NULL,
    category_name,
    lower(regexp_replace(
      normalize(category_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    )),
    'category',
    category_name,
    '',
    category_order - 1,
    true,
    NULL
  FROM catalog
  RETURNING id
)
INSERT INTO tags (
  id, parent_id, name, normalized_name, item_kind, group_name, description,
  sort_order, is_active, created_by_user_id
)
SELECT
  'catalog.tag.' || lpad(catalog.category_order::text, 2, '0') || '.' || lpad(item.tag_order::text, 2, '0'),
  'catalog.category.' || lpad(catalog.category_order::text, 2, '0'),
  item.tag_name,
  lower(regexp_replace(
    normalize(item.tag_name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
  )),
  'tag',
  catalog.category_name,
  '',
  item.tag_order - 1,
  true,
  NULL
FROM catalog
CROSS JOIN LATERAL unnest(catalog.tag_names) WITH ORDINALITY AS item(tag_name, tag_order);
--> statement-breakpoint
ALTER TABLE tags
  ALTER COLUMN item_kind SET NOT NULL,
  ALTER COLUMN normalized_name SET NOT NULL,
  ADD CONSTRAINT tags_id_format_ck CHECK (id ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  ADD CONSTRAINT tags_name_ck CHECK (length(regexp_replace(
    normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
  )) > 0),
  ADD CONSTRAINT tags_normalized_name_ck CHECK (
    normalized_name = lower(regexp_replace(
      normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    )) AND length(normalized_name) > 0
  ),
  ADD CONSTRAINT tags_structure_ck CHECK (
    (item_kind = 'category' AND parent_id IS NULL)
    OR (item_kind = 'tag' AND parent_id IS NOT NULL)
  );
--> statement-breakpoint
DROP INDEX tags_parent_name_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX tags_parent_normalized_name_uq
  ON tags (COALESCE(parent_id, ''), normalized_name);
--> statement-breakpoint
CREATE INDEX tags_parent_sort_idx ON tags (parent_id, sort_order, id);
--> statement-breakpoint
CREATE TABLE tag_aliases (
  id uuid PRIMARY KEY,
  tag_id varchar(120) NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  name varchar(160) NOT NULL,
  normalized_name varchar(160) NOT NULL,
  created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_aliases_name_ck CHECK (length(regexp_replace(
    normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
  )) > 0),
  CONSTRAINT tag_aliases_normalized_name_ck CHECK (
    normalized_name = lower(regexp_replace(
      normalize(name, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'
    )) AND length(normalized_name) > 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX tag_aliases_normalized_name_uq ON tag_aliases(normalized_name);
--> statement-breakpoint
CREATE INDEX tag_aliases_tag_idx ON tag_aliases(tag_id, created_at);
--> statement-breakpoint
CREATE TABLE tag_catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_catalog_state_singleton_ck CHECK (singleton = true),
  CONSTRAINT tag_catalog_state_version_ck CHECK (version > 0)
);
--> statement-breakpoint
INSERT INTO tag_catalog_state(singleton, version) VALUES (true, 1);
--> statement-breakpoint
CREATE TABLE tag_deactivation_previews (
  id uuid PRIMARY KEY,
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_tag_id varchar(120) NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  replacement_tag_id varchar(120) REFERENCES tags(id) ON DELETE RESTRICT,
  catalog_version integer NOT NULL,
  current_problem_count integer NOT NULL,
  sole_current_tag_count integer NOT NULL,
  historical_revision_count integer NOT NULL,
  review_opinion_count integer NOT NULL,
  child_tag_count integer NOT NULL,
  impact_digest char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_deactivation_previews_version_ck CHECK (catalog_version > 0),
  CONSTRAINT tag_deactivation_previews_counts_ck CHECK (
    current_problem_count >= 0
    AND sole_current_tag_count BETWEEN 0 AND current_problem_count
    AND historical_revision_count >= 0
    AND review_opinion_count >= 0
    AND child_tag_count >= 0
  ),
  CONSTRAINT tag_deactivation_previews_digest_ck CHECK (impact_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tag_deactivation_previews_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT tag_deactivation_previews_used_ck CHECK (
    used_at IS NULL OR used_at BETWEEN created_at AND expires_at
  ),
  CONSTRAINT tag_deactivation_previews_replacement_ck CHECK (
    replacement_tag_id IS NULL OR replacement_tag_id <> target_tag_id
  )
);
--> statement-breakpoint
CREATE INDEX tag_deactivation_previews_expiry_idx
  ON tag_deactivation_previews(expires_at, used_at);
--> statement-breakpoint
CREATE FUNCTION enforce_tag_catalog_item()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  parent_kind public.tag_item_kind;
  parent_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_STABLE_ID_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.item_kind IS DISTINCT FROM OLD.item_kind THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_ITEM_KIND_IMMUTABLE';
  END IF;
  IF NEW.item_kind = 'category' THEN
    IF NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATEGORY_PARENT_FORBIDDEN';
    END IF;
    IF NEW.is_active = false AND EXISTS (
      SELECT 1 FROM public.tags child WHERE child.parent_id = NEW.id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATEGORY_HAS_CHILDREN';
    END IF;
  ELSE
    SELECT item_kind, is_active
    INTO parent_kind, parent_active
    FROM public.tags
    WHERE id = NEW.parent_id
    FOR SHARE;
    IF parent_kind IS DISTINCT FROM 'category'::public.tag_item_kind OR parent_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_PARENT_REQUIRES_ACTIVE_CATEGORY';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_active = true AND NEW.is_active = false AND EXISTS (
      SELECT 1
      FROM public.problem_revision_tags link
      JOIN public.problem_revisions revision ON revision.id = link.revision_id
      JOIN public.problems problem
        ON problem.id = revision.problem_id
       AND problem.current_revision = revision.revision
      WHERE link.tag_id = NEW.id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_STILL_USED_BY_CURRENT_REVISION';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER tags_catalog_item_guard
BEFORE INSERT OR UPDATE OF id, parent_id, item_kind, is_active ON tags
FOR EACH ROW EXECUTE FUNCTION enforce_tag_catalog_item();
--> statement-breakpoint
CREATE FUNCTION enforce_active_leaf_tag_reference()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'problem_revision_tags' THEN
      IF NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_REFERENCE_OWNER_IMMUTABLE';
      END IF;
    ELSIF TG_TABLE_NAME = 'review_opinion_tags' THEN
      IF NEW.opinion_id IS DISTINCT FROM OLD.opinion_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_REFERENCE_OWNER_IMMUTABLE';
      END IF;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.tags
    WHERE id = NEW.tag_id AND item_kind = 'tag' AND is_active = true
    FOR SHARE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_REFERENCE_REQUIRES_ACTIVE_LEAF';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER problem_revision_tags_active_leaf_guard
BEFORE INSERT OR UPDATE ON problem_revision_tags
FOR EACH ROW EXECUTE FUNCTION enforce_active_leaf_tag_reference();
--> statement-breakpoint
CREATE TRIGGER review_opinion_tags_active_leaf_guard
BEFORE INSERT OR UPDATE ON review_opinion_tags
FOR EACH ROW EXECUTE FUNCTION enforce_active_leaf_tag_reference();
--> statement-breakpoint
CREATE FUNCTION enforce_leaf_tag_alias()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tags
    WHERE id = NEW.tag_id AND item_kind = 'tag'
    FOR SHARE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_ALIAS_REQUIRES_LEAF';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER tag_aliases_leaf_guard
BEFORE INSERT OR UPDATE OF tag_id ON tag_aliases
FOR EACH ROW EXECUTE FUNCTION enforce_leaf_tag_alias();
--> statement-breakpoint
CREATE FUNCTION validate_current_problem_revision_tags()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  checked_problem_id bigint;
  checked_revision_id uuid;
  tag_count integer;
  checked_tag record;
BEGIN
  IF TG_TABLE_NAME = 'problems' THEN
    checked_problem_id := NEW.id;
  ELSE
    IF TG_OP = 'DELETE' THEN
      checked_revision_id := OLD.revision_id;
    ELSE
      checked_revision_id := NEW.revision_id;
    END IF;
    SELECT revision.problem_id INTO checked_problem_id
    FROM public.problem_revisions revision
    WHERE revision.id = checked_revision_id;
    IF checked_problem_id IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM problem.id
  FROM public.problems problem
  WHERE problem.id = checked_problem_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT revision.id INTO checked_revision_id
  FROM public.problems problem
  JOIN public.problem_revisions revision
    ON revision.problem_id = problem.id
   AND revision.revision = problem.current_revision
  WHERE problem.id = checked_problem_id;

  tag_count := 0;
  FOR checked_tag IN
    SELECT tag.item_kind, tag.is_active
    FROM public.problem_revision_tags link
    JOIN public.tags tag ON tag.id = link.tag_id
    WHERE link.revision_id = checked_revision_id
    ORDER BY link.tag_id
    FOR SHARE OF tag
  LOOP
    tag_count := tag_count + 1;
    IF checked_tag.item_kind IS DISTINCT FROM 'tag'::public.tag_item_kind
      OR checked_tag.is_active IS DISTINCT FROM true
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'CURRENT_PROBLEM_TAG_REFERENCE_INVALID';
    END IF;
  END LOOP;
  IF tag_count NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CURRENT_PROBLEM_TAG_COUNT_INVALID';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER problems_current_tag_count_guard
AFTER INSERT OR UPDATE OF current_revision ON problems
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_current_problem_revision_tags();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER problem_revision_tags_current_count_guard
AFTER INSERT OR UPDATE OR DELETE ON problem_revision_tags
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_current_problem_revision_tags();
--> statement-breakpoint
DO $migration$
DECLARE
  invalid_count integer;
BEGIN
  SELECT count(*)::integer INTO invalid_count
  FROM public.problems problem
  JOIN public.problem_revisions revision
    ON revision.problem_id = problem.id
   AND revision.revision = problem.current_revision
  LEFT JOIN public.problem_revision_tags link ON link.revision_id = revision.id
  GROUP BY problem.id
  HAVING count(link.tag_id) NOT BETWEEN 1 AND 30
  LIMIT 1;
  IF invalid_count IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_CURRENT_TAG_COUNT_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.problems problem
    JOIN public.problem_revisions revision
      ON revision.problem_id = problem.id
     AND revision.revision = problem.current_revision
    JOIN public.problem_revision_tags link ON link.revision_id = revision.id
    JOIN public.tags tag ON tag.id = link.tag_id
    WHERE tag.item_kind <> 'tag' OR tag.is_active = false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TAG_CATALOG_CURRENT_REFERENCE_INVALID';
  END IF;
END
$migration$;
