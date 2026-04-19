import fs from 'fs';

let css = fs.readFileSync('src/index.css', 'utf-8');

// Update z-card-muted
css = css.replace(
  /.z-card-muted \{[\s\S]*?\}/,
  `.z-card-muted {
  @apply bg-white/60 backdrop-blur-3xl p-6 rounded-zarewa border border-white/80;
  box-shadow: 0 20px 60px -32px rgba(15, 23, 42, 0.1), 0 10px 24px -18px rgba(20, 83, 45, 0.06);
}`
);

// Update z-kpi-card
css = css.replace(
  /.z-kpi-card \{[\s\S]*?\}/,
  `.z-kpi-card {
  @apply rounded-[28px] border border-white/80 bg-white/60 backdrop-blur-3xl p-5 text-left transition-all duration-300;
  box-shadow: 0 20px 60px -32px rgba(15, 23, 42, 0.1), 0 10px 24px -18px rgba(20, 83, 45, 0.06);
}`
);

// Update z-soft-panel
css = css.replace(
  /.z-soft-panel \{[\s\S]*?\}/,
  `.z-soft-panel {
  @apply rounded-[28px] border border-white/80 bg-white/60 backdrop-blur-3xl;
  box-shadow: 0 20px 60px -32px rgba(15, 23, 42, 0.1), 0 10px 24px -18px rgba(20, 83, 45, 0.06);
}`
);

// Update z-toolbar-shell
css = css.replace(
  /.z-toolbar-shell \{[\s\S]*?\}/,
  `.z-toolbar-shell {
  @apply rounded-[28px] border border-white/80 bg-white/70 backdrop-blur-2xl;
  box-shadow: 0 20px 60px -32px rgba(15, 23, 42, 0.1), 0 10px 24px -18px rgba(20, 83, 45, 0.06);
}`
);

// Update z-panel-section
css = css.replace(
  /.z-panel-section \{[\s\S]*?\}/,
  `.z-panel-section {
  @apply rounded-[28px] border border-white/80 bg-white/60 backdrop-blur-3xl p-6 sm:p-7;
  box-shadow: 0 20px 60px -32px rgba(15, 23, 42, 0.1), 0 10px 24px -18px rgba(20, 83, 45, 0.06);
}`
);

// Update z-page-hero
css = css.replace(
  /.z-page-hero \{[\s\S]*?\}/,
  `.z-page-hero {
  @apply rounded-[28px] border border-white/80 bg-white/60 backdrop-blur-3xl p-6 sm:p-7 mb-8;
  box-shadow: 0 20px 60px -32px rgba(15, 23, 42, 0.1), 0 10px 24px -18px rgba(20, 83, 45, 0.06);
}`
);

fs.writeFileSync('src/index.css', css);
console.log('Updated index.css tokens to modern glassmorphism aesthetic.');
