export default function plain2html(str: string | undefined): string {
  if (!str) {
    str = "";
  }
  str = str.replaceAll("&", "&amp;");
  str = str.replaceAll("<", "&lt;");
  str = str.replaceAll(">", "&gt;");
  str = str.replaceAll("\"", "&quot;");
  return str;
}