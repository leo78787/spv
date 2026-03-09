/// <reference types="vite/client" />

// Vite inline worker import: `import W from './file?worker&inline'`
declare module '*?worker&inline' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}
