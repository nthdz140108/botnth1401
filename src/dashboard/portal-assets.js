import {portalError} from './portal-policy.js';
const MAX_BYTES=10*1024*1024;
const formats={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp','image/gif':'gif'};
export async function validatePortalAssets(assets=[]) {
 if(!Array.isArray(assets)||assets.length>5)throw portalError('INVALID_ASSETS',400);
 const decoded=[];
 for(const asset of assets){
  if(!asset||typeof asset!=='object'||Object.keys(asset).some(k=>!['id','mime','data_base64'].includes(k))||!/^[a-zA-Z0-9_-]{1,100}$/.test(asset.id||'')||!formats[asset.mime]||typeof asset.data_base64!=='string'||asset.data_base64.length>Math.ceil(MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data_base64))throw portalError('INVALID_ASSETS',400);
  const bytes=Buffer.from(asset.data_base64,'base64');if(!bytes.length||bytes.length>MAX_BYTES)throw portalError('INVALID_ASSETS',400);
  let metadata;try{const {default:sharp}=await import('sharp');metadata=await sharp(bytes,{limitInputPixels:40000000}).metadata();}catch{throw portalError('INVALID_IMAGE',400);}
  if(metadata.format!==formats[asset.mime]||!metadata.width||!metadata.height||metadata.width*metadata.height>40000000)throw portalError('INVALID_IMAGE',400);
  decoded.push({id:asset.id,bytes,extension:metadata.format==='jpeg'?'jpg':metadata.format});
 }
 return decoded;
}
