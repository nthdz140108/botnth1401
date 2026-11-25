import test from 'node:test';import assert from 'node:assert/strict';
const module=await import('../src/dashboard/portal-assets.js').catch(()=>({}));
test('image assets validate limits and content before creating runtime files',async()=>{
 assert.equal(typeof module.validatePortalAssets,'function');
 const png={id:'a',mime:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='};
 assert.equal((await module.validatePortalAssets([png]))[0].extension,'png');
 await assert.rejects(module.validatePortalAssets(Array(6).fill(png)),{code:'INVALID_ASSETS'});
 await assert.rejects(module.validatePortalAssets([{...png,mime:'image/jpeg'}]),{code:'INVALID_IMAGE'});
 await assert.rejects(module.validatePortalAssets([{...png,data_base64:Buffer.from('<script>bad</script>').toString('base64')}]),{code:'INVALID_IMAGE'});
 await assert.rejects(module.validatePortalAssets([{...png,path:'C:/secret'}]),{code:'INVALID_ASSETS'});
});
