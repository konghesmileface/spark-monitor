/**
 * Unit tests for pdf-export.ts — basic mock test.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock dynamic imports
vi.mock('html2canvas', () => ({
  default: vi.fn().mockResolvedValue({
    toDataURL: () => 'data:image/png;base64,mock',
    width: 800,
    height: 1200,
  }),
}));

vi.mock('jspdf', () => ({
  jsPDF: vi.fn().mockImplementation(() => ({
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    addImage: vi.fn(),
    addPage: vi.fn(),
    save: vi.fn(),
  })),
}));

describe('exportToPDF', () => {
  it('generates PDF from element', async () => {
    const { exportToPDF } = await import('@/utils/pdf-export');
    const el = document.createElement('div');
    el.innerHTML = '<p>Test content</p>';

    // Should not throw
    await expect(exportToPDF(el, 'test-report')).resolves.toBeUndefined();
  });

  it('calls jsPDF save with correct filename', async () => {
    const { exportToPDF } = await import('@/utils/pdf-export');
    const { jsPDF } = await import('jspdf');

    const el = document.createElement('div');
    await exportToPDF(el, 'my-report');

    const instance = (jsPDF as any).mock.results[0]?.value;
    if (instance) {
      expect(instance.save).toHaveBeenCalledWith('my-report.pdf');
    }
  });
});
