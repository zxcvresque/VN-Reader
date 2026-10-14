import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const archive=readFileSync(new URL("./archive.json",import.meta.url),"utf8");
export default defineConfig({
  root:fileURLToPath(new URL("../../",import.meta.url)),
  plugins:[react(),{name:"local-qa-fixtures",configureServer(server){
    server.middlewares.use((request,response,next)=>{
      const path=request.url?.split("?")[0];
      const data=path==="/api/archive"?archive:path==="/api/config"?JSON.stringify({accountsEnabled:false,archiveEnabled:true}):path==="/api/auth/get-session"?"null":null;
      if(data===null)return next();
      response.setHeader("Content-Type","application/json");response.end(data);
    });
  }}],
  server:{host:"127.0.0.1",port:5199,strictPort:true}
});
