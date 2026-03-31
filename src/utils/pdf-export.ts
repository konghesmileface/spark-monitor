/**
 * PDF export utility — dynamically imports jspdf + html2canvas
 * to avoid impacting initial bundle size.
 */

export async function exportToPDF(element: HTMLElement, filename: string): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#0C1222',
    logging: false,
  });

  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * contentWidth) / canvas.width;

  let yOffset = 0;
  let page = 0;

  while (yOffset < imgHeight) {
    if (page > 0) pdf.addPage();

    pdf.addImage(
      imgData,
      'PNG',
      margin,
      margin - yOffset,
      contentWidth,
      imgHeight,
    );

    yOffset += pageHeight - margin * 2;
    page++;
  }

  pdf.save(`${filename}.pdf`);
}
