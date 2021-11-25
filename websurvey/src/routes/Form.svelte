<script>
    import { createEventDispatcher } from "svelte";
    import { navigate } from "svelte-routing";

    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import typeformData from "../typeformData.js";

    const { fields } = typeformData;
    const { length } = fields;

    export let ref;
    let currentIndex;
    let field;

    $: {
      currentIndex = fields.findIndex(x => x.ref == ref)
      field = fields[currentIndex]
    }

    const handleSubmit = () => {
         if (currentIndex < fields.length - 1) {
             const newRef = fields[currentIndex + 1].ref;
             navigate(`/${newRef}`, { replace: true });
         }
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <!-- Question -->
                    <h2 class="label-wrapper">
                        <label for="question-{currentIndex + 1}">Question
                            {currentIndex + 1}
                            out of
                            {length}</label>
                    </h2>
                    {#if field.type === 'short_text'}
                        <ShortText {field} />
                    {:else if (field.type == 'multiple_choice')}
                        <MultipleChoice {field} />
                    {:else}
                        <p>You've reached the end of the survey!</p>
                    {/if}

            <button class="btn">OK</button>
        </div>
    </form>
</div>
