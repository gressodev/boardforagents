// The time source for verification and for new notices' timestamps. Tests replace clock.now
// to move through grace periods without waiting; nothing else should touch it.
const clock = { now: () => Date.now() };

module.exports = { clock };
