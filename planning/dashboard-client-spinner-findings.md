# Dashboard Client - Spinner & Loading Indicator Search Results

Date: 2026-02-16

## Summary

The dashboard-client codebase has **multiple existing spinner/loading patterns** available for reuse:

1. **Custom SVG Spinner component** - Full-page overlay spinner
2. **Ant Design Spin component** - Lightweight, built-in loading indicator
3. **CSS rotation animation** - Generic @keyframes for rotation effects
4. **Styled component wrapper** - Already styled Spin wrapper for modal usage

---

## 1. Custom SVG Spinner Component

**Location:** `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/Spinner/`

### Files:
- `Spinner.js` - React wrapper component
- `spinner.svg` - SVG graphic with built-in rotation animation

### Details:

```javascript
// Spinner.js
import React from 'react';
import spinner from './spinner.svg';

const Spinner = () => {
  const style = {
    position: 'absolute',
    display: 'flex',
    justifyContent: 'center',
    height: '100vh',
    width: '100vw',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'white',
  };

  return (
    <div style={style}>
      <img src={spinner} alt="loading" />
    </div>
  );
};

export default Spinner;
```

### SVG Details:
- SVG file contains an `<animateTransform>` element that rotates the spinner
- **Animation spec:** `from="0 50 50" to="360 50 50" repeatCount="indefinite" dur="1s"`
- **Rotation speed:** 1 second per full rotation
- **Fill color:** #337ab7 (Bootstrap blue)
- **Size:** 120px x 120px
- **Styling:** Full-page white overlay with centered spinner

### Use Case:
- **Current usage:** Full-page loading screen (covers entire viewport)
- **Not suitable for inline use** - takes up full screen
- **Would need modification** for small inline indicator

---

## 2. Ant Design Spin Component

**UI Library:** antd ^4.8.6 (already a dependency)

**Imported in:**
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/PrivateRoute/PrivateRoute.js` (line 5)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/UI/index.js` (line 3)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/LinkModal/style.js` (line 2)
- `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` (line 6)

### Usage Examples:

#### Example 1: Full-page loading (PrivateRoute.js)
```javascript
{auth.renewing ? (<Spin size="large" style={{ margin: '45vh auto' }} />) : (...)}
```

#### Example 2: Styled wrapper (UI/index.js - "Loading" component)
```javascript
export const Loading = ({ children }) => (
  <div style={{ margin: '45vh auto', textAlign: 'center' }}>
    <Spin style={{ display: 'block' }} />
    {children}
  </div>
);
```

#### Example 3: Styled-components wrapper (LinkModal/style.js)
```javascript
export const Spinner = styled(Spin)`
  margin: 30vh auto;
`;
```

#### Example 4: Table overlay (SurveyScreen.js)
```javascript
<Spin spinning={loading}>
  <Table columns={exportColumns} dataSource={exports} ... />
</Spin>
```

### Ant Design Spin Capabilities:
- **Sizes:** `small`, `default`, `large`
- **Props:**
  - `spinning={boolean}` - Show/hide spinner
  - `size={string}` - Control size
  - `indicator={ReactNode}` - Custom spinner icon (can pass Icon or SVG)
  - `delay={number}` - Delay before showing (avoids flashing for quick operations)
  - `tip={string}` - Text to show below spinner
- **Default appearance:** Rotating dot pattern
- **Built-in animation:** CSS-based rotation

### Advantages:
- ✅ Already a dependency (no additional libraries needed)
- ✅ Can wrap content or be standalone
- ✅ Supports custom tip text
- ✅ Size variants available
- ✅ Can accept custom indicator components
- ✅ Can be used inline or full-page

### Best For Inline "Export in Progress" Indicator:
- ✅ Lightweight and built-in
- ✅ No extra SVG files needed
- ✅ Already used throughout the codebase
- ✅ Can add a `tip="Exporting..."` message

---

## 3. CSS Rotation Animation

**Location:** `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/App/App.css`

```css
@keyframes App-logo-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.App-logo {
  animation: App-logo-spin infinite 20s linear;
}
```

### Details:
- Generic CSS keyframes for 360° rotation
- **Duration:** 20 seconds (suitable for logo animation)
- **Timing:** Linear (constant speed)
- Can be adapted for different durations and speeds

### Use Case:
- Could be extracted and reused for custom inline spinner
- Currently used only for logo, not for loading indicators
- Could be copied/modified if custom animation needed

---

## 4. Styled-Components Spin Wrapper (LinkModal)

**Location:** `/home/nandan/Documents/vlab-research/fly/dashboard-client/src/components/LinkModal/style.js` (lines 4-6)

```javascript
export const Spinner = styled(Spin)`
  margin: 30vh auto;
`;
```

### Details:
- Wraps antd `Spin` component with styled-components
- Provides centered positioning with `30vh` top margin
- Named `Spinner` (note: this is already a named export, so avoid naming conflicts if importing)

### Use Case:
- Pattern for styling Spin components in this codebase
- Could follow this pattern for inline indicator styling

---

## Recommendation for "Export in Progress" Indicator

### Best Approach: Use antd Spin with styled-components wrapper

```javascript
// Option 1: Simple inline indicator
<Spin size="small" tip="Exporting..." />

// Option 2: Styled wrapper (following existing pattern)
const ExportSpinner = styled(Spin)`
  margin: 10px 0;
`;

<ExportSpinner spinning={isExporting} tip="Exporting..." />
```

### Why This Approach:
1. ✅ **No additional dependencies** - antd already imported
2. ✅ **Consistent with codebase** - Spin used in multiple places already
3. ✅ **Flexible sizing** - `size="small"` for inline use, can grow if needed
4. ✅ **Built-in text support** - `tip` prop for "Exporting..." message
5. ✅ **Easily customizable** - Can style with styled-components pattern
6. ✅ **Proven pattern** - Already used in PrivateRoute, SurveyScreen, LinkModal
7. ✅ **Minimal code** - No new files needed, just inline component usage

### Example Implementation:
```javascript
// In Exports.js or CreateFullMessagesExport.js
const [isExporting, setIsExporting] = useState(false);

// During export:
setIsExporting(true);
// ... make API call
setIsExporting(false);

// In JSX:
<div>
  <button onClick={handleExport} disabled={isExporting}>
    Export
  </button>
  {isExporting && (
    <div style={{ marginTop: '10px' }}>
      <Spin size="small" tip="Exporting..." />
    </div>
  )}
</div>
```

---

## Available Spinners Summary Table

| Type | Location | Size | Use Case | Reusability |
|------|----------|------|----------|-------------|
| **SVG Custom** | `/components/Spinner/` | 120px | Full-page overlay | Low (full-screen only) |
| **antd Spin** | antd library | Configurable | Inline or overlay | High ✅ |
| **CSS Animation** | App.css | Custom | Generic rotation | Medium |
| **Styled Spin** | LinkModal/style.js | Custom | Modal context | High ✅ |

---

## Files Containing Loading/Spinner Usage

1. `/dashboard-client/src/components/PrivateRoute/PrivateRoute.js` - Auth renewing spinner
2. `/dashboard-client/src/components/UI/index.js` - Generic `<Loading>` component
3. `/dashboard-client/src/components/Spinner/Spinner.js` - Full-page SVG spinner
4. `/dashboard-client/src/components/LinkModal/style.js` - Styled Spin wrapper
5. `/dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` - Table loading state
6. `/dashboard-client/src/containers/Exports/Exports.js` - Uses `<Loading>` component
7. `/dashboard-client/src/containers/App/App.css` - CSS animation keyframes

---

## Dependencies Already Available

From `package.json`:
- ✅ **antd**: ^4.8.6 - Includes Spin component
- ✅ **@ant-design/icons**: ^4.3.0 - For custom icons if needed
- ✅ **styled-components**: ^4.4.1 - For styling

---

## Implementation Notes

1. **No new dependencies needed** - everything is already available
2. **Consistency important** - use existing patterns (styled-components for styling)
3. **Size recommendation** - use `size="small"` for inline indicators to avoid being too prominent
4. **Placement** - keep near the button/action that triggered the export
5. **Text message** - use `tip` prop to communicate status to user
