export interface EmbeddableFile {
  filename: string;
  contentType: string;
  byteSize: number | null;
  url: string;
  downloadUrl: string;
}

export interface ViewerProps {
  file: EmbeddableFile;
}
