use anchor_lang::prelude::*;

declare_id!("9viJvWnSPMgBibr2edQM6nHwZTmUHy8JC8AKAbEcko8w");

#[program]
pub mod metlev_engine {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
