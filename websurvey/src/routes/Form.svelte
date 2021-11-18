<script>
    import { createEventDispatcher } from "svelte";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import typeformData from "../typeformData.js";

    let dispatch = createEventDispatcher();

    const { fields } = typeformData;
    const { length } = fields;

    const getCurrentId = (index) => {
        const id = fields[index].id;
        return id;
    };

    let currentId = getCurrentId(0);

    let currentIndex = fields.findIndex((field) => field?.id === currentId);

    currentId = getCurrentId(currentIndex);

    const handleSubmit = () => {
        if (currentIndex < fields.length - 1) {
            currentIndex += 1;
        }
        currentIndex;
        dispatch("indexUpdate", currentIndex);
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <!-- Question -->
            {#each fields as field, index (field.id)}
                {#if currentIndex === index}
                    <h2 class="label-wrapper">
                        <label for="question-{index + 1}">Question
                            {index + 1}
                            out of
                            {length}</label>
                    </h2>
                    {#if field.type === 'short_text'}
                        <ShortText {field} />
                    {:else if (field.type = 'multiple_choice')}
                        <MultipleChoice {field} />
                    {:else}
                        <p>You've reached the end of the survey!</p>
                    {/if}
                {/if}
            {/each}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
