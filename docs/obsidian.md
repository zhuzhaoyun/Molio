# Knowledge Graph（知识图谱）可视化模块开发规范

## 项目目标

实现一个类似 Obsidian Graph View 的交互式知识图谱系统。

图谱用于展示：

* 文档(Document)
* 知识点(Knowledge)
* 标签(Tag)
* 项目(Project)
* Agent
* 工作流(Workflow)

之间的关联关系。

要求：

* 支支持数千~数万节点流畅渲染
* 支持实时缩放与拖拽
* 支持动态聚焦
* 支持力导向布局（Force Graph）
* 支持暗色主题
* 支持节点高亮
* 支持关系追踪
* 整体视觉参考 Obsidian，但更加现代和专业

---

# 技术选型

优先：

```ts
react-force-graph-2d
```

或者

```ts
react-force-graph-3d
```

底层：

```ts
d3-force
```

要求：

```ts
60fps
10000+ nodes
```

支持：

```ts
Canvas 渲染
WebGL 渲染
```

自动切换。

---

# 整体视觉风格

风格关键词：

```text
Minimal
Technical
AI Native
Knowledge Network
Dark Mode First
```

不要：

```text
彩虹色
高饱和度
卡通风格
```

---

# 背景颜色

采用 Obsidian 风格深色背景。

```css
background: #0F1117;
```

备用：

```css
#111827
```

或者：

```css
#0B0F19
```

效果：

* 接近夜空
* 不纯黑
* 减少视觉疲劳

---

# 节点设计

## 普通节点

颜色：

```css
fill: #9CA3AF;
```

尺寸：

```ts
radius = 4~8
```

透明度：

```css
opacity: 0.85;
```

效果：

类似截图中的灰色圆点。

---

## 当前选中节点

颜色：

```css
#FFFFFF
```

描边：

```css
#60A5FA
```

描边宽度：

```ts
3px
```

尺寸：

```ts
1.5x
```

发光效果：

```css
box-shadow:
0 0 12px rgba(96,165,250,.8);
```

---

## Hover节点

颜色：

```css
#D1D5DB
```

轻微放大：

```ts
1.2x
```

---

## 中心节点

例如：

```text
INDEX
ROOT
知识库
```

颜色：

```css
#F3F4F6
```

尺寸：

```ts
20~30
```

描边：

```css
#94A3B8
```

---

# 节点分类颜色

不同类型节点采用低饱和度配色。

## 文档

```css
#94A3B8
```

灰蓝

---

## 标签

```css
#22C55E
```

绿色

---

## Agent

```css
#8B5CF6
```

紫色

---

## 工作流

```css
#F59E0B
```

橙色

---

## 项目

```css
#3B82F6
```

蓝色

---

## AI模型

```css
#EF4444
```

红色

---

# 节点文字

字体：

```css
Inter
```

或者

```css
PingFang SC
```

字号：

```css
12px
```

颜色：

```css
#D1D5DB
```

显示规则：

```text
缩放较小时隐藏
缩放达到阈值显示
```

例如：

```ts
zoom > 1.2
```

显示文字。

---

# 连线设计

## 默认连线

颜色：

```css
rgba(255,255,255,0.08)
```

宽度：

```ts
1px
```

效果：

非常淡。

类似截图中的蜘蛛网效果。

---

## Hover关联线

颜色：

```css
rgba(96,165,250,.7)
```

宽度：

```ts
2px
```

---

## 当前节点关系

颜色：

```css
#60A5FA
```

宽度：

```ts
3px
```

透明度：

```css
1
```

---

# 力导向布局参数

目标效果：

节点自然散开。

不要：

```text
挤成一团
```

推荐参数：

```ts
chargeStrength = -120

linkDistance = 120

collisionRadius = 20

alphaDecay = 0.02
```

支持：

```ts
自动布局
手动拖动
锁定节点
```

---

# 交互效果

## Hover节点

触发：

```text
鼠标移动到节点
```

效果：

高亮：

* 当前节点
* 一级关联节点
* 一级关联线

其余元素降低透明度：

```css
opacity: 0.15
```

---

## 点击节点

触发：

```text
单击
```

效果：

图谱聚焦到节点。

动画：

```ts
800ms
```

平滑移动。

同时打开：

```text
右侧详情面板
```

展示：

* 标题
* 类型
* 摘要
* 标签
* 引用关系

---

## 双击节点

打开对应文档。

```ts
router.push(...)
```

---

## 拖拽节点

支持：

```text
自由拖动
```

松开后：

```text
保持位置
```

即：

```ts
node.fx
node.fy
```

锁定。

---

## 空白区域点击

取消选中。

恢复：

```text
默认状态
```

---

# 缩放体验

鼠标滚轮：

```text
缩放
```

范围：

```ts
0.2x ~ 8x
```

双指缩放支持。

---

# MiniMap

右下角增加：

```text
MiniMap
```

显示：

* 当前视口
* 全局节点分布

类似：

```text
Figma
Miro
```

体验。

---

# 搜索功能

顶部搜索框：

```text
搜索节点
```

支持：

* 标题
* 标签
* 内容

输入后：

```text
自动定位节点
自动高亮
```

---

# 筛选功能

支持：

```text
文档
标签
Agent
项目
工作流
模型
```

开关过滤。

---

# 动画效果

首次进入：

```text
节点从中心扩散
```

动画：

```ts
1500ms
```

缓动：

```ts
easeOutCubic
```

---

# 性能要求

5000节点：

```text
60fps
```

10000节点：

```text
30fps+
```

优化方案：

```ts
requestAnimationFrame

Canvas Layer

WebGL Layer

Node Culling

LOD(Level of Detail)
```

---

# 高级增强（第二阶段）

支持：

### 社区聚类

自动识别：

```text
Agent
项目
知识主题
```

形成 Cluster。

边界使用淡色光晕表示。

---

### 时间维度

时间滑块：

```text
查看知识增长过程
```

类似：

```text
Git History
```

---

### AI 关系发现

自动分析：

```text
文档相似度
关键词
Embedding
```

生成：

```text
隐式关系边
```

颜色：

```css
#8B5CF6
```

虚线显示。

---

# 最终视觉目标

整体效果应达到：

```text
70% Obsidian Graph
+
20% Palantir Ontology
+
10% Linear/Figma 的现代感
```

视觉感受：

* 深色背景
* 密集关系网络
* 节点微发光
* Hover即聚焦
* 大规模知识网络探索体验
* 像在浏览自己的第二大脑

```

可以生成类似 Obsidian Graph 的深色知识图谱效果，包括节点、连线、背景、交互、缩放、发光、hover等效果。你可以直接在你的项目里使用：

---

```json
{
  "graph": {
    "background": "#0F1117",
    "layout": {
      "type": "force-directed",
      "chargeStrength": -120,
      "linkDistance": 120,
      "collisionRadius": 20,
      "alphaDecay": 0.02
    },
    "nodes": {
      "default": {
        "color": "#9CA3AF",
        "radius": 6,
        "opacity": 0.85,
        "label": {
          "fontFamily": "PingFang SC",
          "fontSize": 12,
          "color": "#D1D5DB",
          "visibleZoomThreshold": 1.2
        }
      },
      "hover": {
        "scale": 1.2,
        "color": "#D1D5DB"
      },
      "selected": {
        "scale": 1.5,
        "color": "#FFFFFF",
        "borderColor": "#60A5FA",
        "borderWidth": 3,
        "glow": "0 0 12px rgba(96,165,250,0.8)"
      },
      "types": {
        "document": "#9CA3AF",
        "tag": "#22C55E",
        "agent": "#8B5CF6",
        "project": "#3B82F6",
        "workflow": "#F59E0B",
        "aiModel": "#EF4444"
      }
    },
    "links": {
      "default": {
        "color": "rgba(255,255,255,0.08)",
        "width": 1
      },
      "hover": {
        "color": "rgba(96,165,250,0.7)",
        "width": 2
      },
      "selectedNode": {
        "color": "#60A5FA",
        "width": 3,
        "opacity": 1
      }
    },
    "interactions": {
      "hoverNode": {
        "highlightNode": true,
        "highlightLinks": true,
        "fadeOthersOpacity": 0.15
      },
      "clickNode": {
        "focusNode": true,
        "centerNode": true,
        "smoothMoveDuration": 800,
        "openSidePanel": true
      },
      "doubleClickNode": {
        "openDocument": true
      },
      "dragNode": {
        "fixPosition": true
      },
      "clickBlank": {
        "deselect": true
      },
      "zoom": {
        "min": 0.2,
        "max": 8
      }
    },
    "minimap": {
      "enabled": true,
      "showViewport": true,
      "background": "#1F2230"
    },
    "animations": {
      "initialLoad": {
        "type": "spreadFromCenter",
        "duration": 1500,
        "easing": "easeOutCubic"
      }
    },
    "performance": {
      "targetFPS": 60,
      "maxNodesSmooth": 5000,
      "maxNodesFallback": 10000,
      "optimizations": ["requestAnimationFrame", "CanvasLayer", "WebGLLayer", "NodeCulling", "LOD"]
    }
  }
}
```

---

✅ **特点总结**：

* 深色护眼背景，不是纯黑色
* 节点颜色区分类型，Hover 与选中节点有发光效果
* 连线淡色，Hover/选中节点时高亮
* 力导向布局，自然散开
* 交互体验接近 Obsidian Graph：拖拽、缩放、点击聚焦、双击打开文档
* MiniMap 支持查看全局节点分布
* 性能优化保证大规模节点流畅渲染

---
