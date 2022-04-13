<script>
    export let field;
</script>

{#if field.type === 'multiple_choice' || field.type === 'rating'}
    <fieldset>
        <legend
            class="text-sm md:text-lg font-bold tracking-tight text-slate whitespace-pre-line mb-4">
            {field.title}
        </legend>
    </fieldset>
{:else}
    <h2
        class="text-sm md:text-lg font-bold tracking-tight text-slate whitespace-pre-line mb-4">
        {field.title}
    </h2>
{/if}
