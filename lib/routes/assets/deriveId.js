// 按显示名推一个示例 id，并说明它当前是否撞车。
module.exports = function register(router, ctx) {
 const { assetId, collectTakenVoiceIds, loadVoices, requireApiKey, trainingPipeline } = ctx;

router.post("/api/assets/derive-id", requireApiKey, (req, res) => {
 const displayName = String((req.body && req.body.display_name) || "").trim();
 if (!displayName) return res.status(400).json({ error: "display_name is required" });
 const { base, proposed } = assetId.proposeVoiceId(displayName);
 // Surface whether the illustrative proposal currently collides so the UI can
 // hint that the final id will differ.
 let collides = false;
 try { collides = collectTakenVoiceIds({ loadVoices, assetId, trainingPipeline }).has(proposed); } catch (_) {}
 res.json({ proposed_id: proposed, base, reserved: false, collides });
});

 return router;
};
