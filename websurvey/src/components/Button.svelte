<!--<script>
    import { createEventDispatcher } from "svelte";
    const dispatch = createEventDispatcher();
    export let view;
</script>{#if view === 'homepage'}
    <button
        class="btn"
        on:click|once={() => dispatch('homepageClick', 'homepage button clicked')}
        view>Let's go!</button>
{:else if view === 'survey'}
    <button
        class="btn"
        on:click|once={() => dispatch('surveyClick', 'survey button clicked')}
        view>OK</button>
{:else}<button type="submit">Submit</button>{/if} -->
