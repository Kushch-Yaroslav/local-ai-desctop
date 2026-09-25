//! Local AI Desktop Agent Runtime V2.
//!
//! The architecture deliberately follows the durable parts of Jan Agent's
//! design: an append-only canonical transcript, a pure context projection and
//! one model/tool turn cycle.  This is an adaptation, not a source copy.
pub mod agent;
pub mod context;
pub mod process;
pub mod protocol;
pub mod tools;
