# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-08-12

### Added

- **Modernized Webview Interface & Layout**:
  - Redesigned webview toolbar with improved controls, spacing, and visual grouping.
  - Enhanced dependency data table styling and typography for improved scanability.
  - Refreshed high-contrast, dark mode, and light mode visual themes in `theme.css`.

### Changed

- **Test Infrastructure Consolidation**:
  - Unified test directory layout by consolidating `test/` into `tests/`.
  - Updated build configurations (`tsconfig.json`, `tsconfig.integration.json`, `vitest.config.ts`, `biome.json`, and `package.json`) to reflect unified test structure.
- **Branding & Vector Assets**:
  - High-resolution SVG and PNG branding asset updates (`panorama.svg` and `panorama.png`).

## [1.1.0] - 2026-08-12

### Added

- **Keyboard Navigation & Accessibility**:
  - Global `Ctrl+F` / `Cmd+F` keyboard shortcut to focus and select the webview search filter input.
  - Roving `tabindex` and arrow key navigation support across dependency data tables and search result lists.
  - ARIA progress roles, live regions (`aria-live="polite"`), and semantic attributes for screen readers.
  - Grouped toolbar filter controls with enhanced keyboard focus styling and high-contrast theme support.
- **Error Notification Queuing**:
  - Error queuing toast alert system to manage and present multiple concurrent host/registry errors without silent dropping.
- **Branding & Visuals**:
  - Vector branding assets (`panorama.svg` and `panorama.png`) for extension sidebar icon and webview headers.

### Changed

- Enhanced registry provider abstraction with input validation and LRU cache eviction policies for dependency metadata and security vulnerability lookups.
- Standardized cross-platform path normalization across integration test helpers.

## [1.0.0] - 2026-08-10

### Added

- First implementation of Panorama.